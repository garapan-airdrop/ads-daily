
const fs = require('fs').promises;
const fsSync = require('fs'); // For synchronous directory creation
const path = require('path');
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const cron = require('node-cron');
const winston = require('winston');
require('dotenv').config();

// Add fetch for Node.js versions that don't have it globally
const fetch = globalThis.fetch || (() => {
    try {
        return require('node-fetch');
    } catch (e) {
        throw new Error('fetch is not available. Please install node-fetch or use Node.js 18+');
    }
})();

class TelegramMultiChannelBot {
    constructor() {
        // Optimized bot configuration with better timeout handling
        this.bot = new Bot(process.env.TELEGRAM_BOT_TOKEN, {
            client: {
                timeoutSeconds: 60, // 60 detik - lebih toleran untuk koneksi lambat
                canUseWebhookReply: false,
                apiRoot: 'https://api.telegram.org',
                baseFetchConfig: {
                    // Tambahan config untuk fetch
                    compress: true,
                    agent: null // Gunakan default agent Node.js
                }
            }
        });
        
        this.channels = {}; // Active channels only (enabled !== false)
        this.allChannels = {}; // All channels including disabled ones
        this.globalSettings = {};
        this.postingRules = {};
        this.isRunning = false;
        this.scheduledTasks = new Map();
        this.postingLocks = new Set();
        this.pendingUploads = new Map();
        this.uploadTimeouts = new Map();
        this.conversationState = new Map(); // multi-step menu conversations
        
        // Rate limiting untuk 32 channels - lebih ringan
        this.rateLimiter = {
            lastRequest: 0,
            minDelay: 500, // 500ms - lebih cepat tapi masih aman
            requestQueue: [],
            processing: false
        };

        // Create essential directories before logger initialization to prevent ENOENT errors
        this.ensureBasicDirectories();
        
        this.setupLogger();
        this.setupErrorHandler();
        
        // Flag to track initialization status
        this.isInitialized = false;
    }

    async init() {
        // Async initialization method - must be called and awaited before starting the bot
        if (this.isInitialized) {
            this.logger.warn('⚠️ Bot already initialized, skipping...');
            return;
        }

        try {
            this.logger.info('🔄 Initializing bot...');
            
            // Load configuration
            await this.loadConfig();
            
            // Create all necessary directories
            await this.createDirectories();
            
            // Validate channel access (optional, can be slow)
            // await this.validateChannelAccess();
            
            this.isInitialized = true;
            this.logger.info('✅ Bot initialization complete');
        } catch (error) {
            this.logger.error(`❌ Bot initialization failed: ${error.message}`);
            throw error;
        }
    }

    ensureBasicDirectories() {
        // Create essential directories synchronously before logger initialization
        // This prevents ENOENT errors when logger tries to write to log files
        const basicDirs = ['logs', 'history', 'assets'];
        
        for (const dir of basicDirs) {
            try {
                if (!fsSync.existsSync(dir)) {
                    fsSync.mkdirSync(dir, { recursive: true });
                }
            } catch (error) {
                // If we can't create directories, log to console
                console.error(`Failed to create directory ${dir}:`, error.message);
            }
        }
    }

    setupLogger() {
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message }) => {
                    return `${timestamp} - ${level.toUpperCase()} - ${message}`;
                })
            ),
            transports: [
                new winston.transports.Console(),
                new winston.transports.File({ 
                    filename: path.join('logs', `telegram_bot_${new Date().toISOString().split('T')[0]}.log`) 
                })
            ]
        });
    }

    async loadConfig() {
        try {
            const configData = await fs.readFile('channels_config.json', 'utf8');
            const config = JSON.parse(configData);

            // Store ALL channels (including disabled) for config persistence
            this.allChannels = {};
            this.channels = {};
            
            config.channels?.forEach(channel => {
                // Save to allChannels regardless of enabled status
                this.allChannels[channel.id] = channel;
                
                // Only save to channels if enabled
                if (channel.enabled !== false) {
                    this.channels[channel.id] = channel;
                }
            });

            this.globalSettings = config.global_settings || {};
            this.postingRules = config.posting_rules || {};

            // Auto-generate posting times if not set
            await this.autoGeneratePostingTimes();

            const totalChannels = Object.keys(this.allChannels).length;
            const activeChannels = Object.keys(this.channels).length;
            const disabledChannels = totalChannels - activeChannels;
            
            this.logger.info(`📋 Config loaded: ${activeChannels} active, ${disabledChannels} disabled, ${totalChannels} total channels`);
        } catch (error) {
            this.logger.error(`❌ Error loading config: ${error.message}`);
            throw error;
        }
    }

    async autoGeneratePostingTimes() {
        const activeChannels = Object.values(this.channels);
        const existingTimes = new Set();
        let hasChanges = false;

        // Collect existing valid times
        activeChannels.forEach(channel => {
            if (channel.posting_time && channel.posting_time.match(/^\d{1,2}:\d{2}$/)) {
                existingTimes.add(channel.posting_time);
            }
        });

        let currentHour = 13; // Start at 1 PM (13:00)
        let currentMinute = 0;

        activeChannels.forEach((channel) => {
            // Skip if posting_time already exists and is valid
            if (channel.posting_time && channel.posting_time.match(/^\d{1,2}:\d{2}$/)) {
                return;
            }

            // Find next available time slot
            let timeSlot;
            do {
                if (currentMinute >= 60) {
                    currentHour++;
                    currentMinute = 0;
                }

                // Wrap around after 22:00 (10 PM)
                if (currentHour > 22) {
                    currentHour = 13;
                    currentMinute = 0;
                }

                timeSlot = `${currentHour.toString().padStart(2, '0')}:${currentMinute.toString().padStart(2, '0')}`;
                currentMinute += 5; // 5-minute intervals to avoid collisions

            } while (existingTimes.has(timeSlot));

            channel.posting_time = timeSlot;
            existingTimes.add(timeSlot);
            hasChanges = true;
            this.logger.info(`🕐 Auto-assigned time ${channel.posting_time} to ${channel.name}`);
        });

        // Save changes if any
        if (hasChanges) {
            await this.saveConfig();
        }
    }

    async saveConfig() {
        try {
            // Sync changes from this.channels back to this.allChannels
            // This ensures any modifications to active channels are persisted
            Object.keys(this.channels).forEach(channelId => {
                this.allChannels[channelId] = this.channels[channelId];
            });
            
            const config = {
                channels: Object.values(this.allChannels), // Save ALL channels, not just active ones
                global_settings: this.globalSettings,
                posting_rules: this.postingRules
            };

            await fs.writeFile('channels_config.json', JSON.stringify(config, null, 2));
            this.logger.info('💾 Config saved successfully');
        } catch (error) {
            this.logger.error(`❌ Error saving config: ${error.message}`);
        }
    }

    async createDirectories() {
        const dirs = [
            'assets', // Base assets folder
            this.globalSettings.history_folder || 'history',
            this.globalSettings.logs_folder || 'logs',
            this.globalSettings.promo_folder || 'assets/promo'
        ];

        // Create specific channel folders under assets
        for (const channel of Object.values(this.channels)) {
            if (channel.image_folder && channel.image_folder.startsWith('assets/')) {
                dirs.push(channel.image_folder);
            }
        }

        for (const dir of dirs) {
            try {
                await fs.mkdir(dir, { recursive: true });
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    this.logger.error(`❌ Error creating directory ${dir}: ${error.message}`);
                }
            }
        }
    }

    async validateChannelAccess() {
        for (const [channelId, channel] of Object.entries(this.channels)) {
            try {
                await this.rateLimitedRequest(() => this.bot.api.getChat(channelId));
                this.logger.info(`✅ Channel access valid: ${channel.name} (${channelId})`);
            } catch (error) {
                this.logger.error(`❌ Cannot access channel ${channelId}: ${error.message}`);
            }
        }
    }
    
    // Rate limiter untuk mencegah flood
    async rateLimitedRequest(requestFn, maxRetries = 5) {
        const executeRequest = async (retryCount = 0) => {
            try {
                // Tunggu minimal delay sejak request terakhir
                const now = Date.now();
                const timeSinceLastRequest = now - this.rateLimiter.lastRequest;
                if (timeSinceLastRequest < this.rateLimiter.minDelay) {
                    await new Promise(resolve => 
                        setTimeout(resolve, this.rateLimiter.minDelay - timeSinceLastRequest)
                    );
                }
                
                this.rateLimiter.lastRequest = Date.now();
                return await requestFn();
                
            } catch (error) {
                // Deteksi error 429 Too Many Requests dari Telegram
                const is429 = error.message?.includes('429') || 
                              error.message?.includes('Too Many Requests');
                
                if (is429 && retryCount < maxRetries) {
                    // Ambil waktu retry-after dari pesan error Telegram
                    const retryAfterMatch = error.message?.match(/retry after (\d+)/i);
                    const retryAfterSec = retryAfterMatch ? parseInt(retryAfterMatch[1]) : 20;
                    const waitMs = (retryAfterSec + 2) * 1000; // tambah buffer 2 detik
                    this.logger.warn(`⚠️ Rate limited by Telegram (429), waiting ${retryAfterSec + 2}s before retry... (${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                    return executeRequest(retryCount + 1);
                }

                // Retry untuk network errors
                const isRetryable = 
                    error.message?.includes('ETIMEDOUT') ||
                    error.message?.includes('ECONNRESET') ||
                    error.message?.includes('ENOTFOUND') ||
                    error.message?.includes('EHOSTUNREACH') ||
                    error.message?.includes('Network request') ||
                    error.message?.includes('fetch failed') ||
                    error.code === 'ETIMEDOUT' ||
                    error.code === 'ECONNRESET' ||
                    error.code === 'ENOTFOUND' ||
                    error.code === 'EHOSTUNREACH';
                
                if (isRetryable && retryCount < maxRetries) {
                    // Exponential backoff: 2s, 4s, 8s, 16s, 30s
                    const backoffDelay = Math.min(2000 * Math.pow(2, retryCount), 30000);
                    this.logger.warn(`⚠️ Request failed (${error.message}), retrying in ${backoffDelay/1000}s... (${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
                    return executeRequest(retryCount + 1);
                }
                
                throw error;
            }
        };
        
        return executeRequest();
    }

    async getMediaFiles(channelId) {
        const imageFolder = this.channels[channelId]?.image_folder || 
                           this.globalSettings.promo_folder || 'assets/promo';

        const mediaExtensions = this.postingRules.media_formats || 
                               ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.mp4', '.avi', '.mov', '.mkv'];

        try {
            const files = await fs.readdir(imageFolder);
            const mediaFiles = files.filter(file => {
                const ext = path.extname(file).toLowerCase();
                return mediaExtensions.includes(ext);
            });

            // Sort by modification time
            const filesWithStats = await Promise.all(
                mediaFiles.map(async file => {
                    const filePath = path.join(imageFolder, file);
                    const stats = await fs.stat(filePath);
                    return { file, mtime: stats.mtime, isVideo: this.isVideoFile(file) };
                })
            );

            return filesWithStats
                .sort((a, b) => a.mtime - b.mtime)
                .map(item => item);
        } catch (error) {
            this.logger.error(`❌ Error getting media files from ${imageFolder}: ${error.message}`);
            return [];
        }
    }

    isVideoFile(filename) {
        const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm'];
        const ext = path.extname(filename).toLowerCase();
        return videoExtensions.includes(ext);
    }

    async loadChannelHistory(channelId) {
        const historyFolder = this.globalSettings.history_folder || 'history';
        const cleanChannelId = channelId.replace(/[@-]/g, '_');
        const historyFile = path.join(historyFolder, `${cleanChannelId}_history.json`);

        try {
            const data = await fs.readFile(historyFile, 'utf8');
            const history = JSON.parse(data);

            // Complete migration from old format to new format
            let needsSaving = false;
            if (history.posted_images && !history.posted_media) {
                history.posted_media = [...history.posted_images];
                delete history.posted_images;
                needsSaving = true;
            }

            // Ensure posted_media is always an array
            if (!Array.isArray(history.posted_media)) {
                history.posted_media = [];
                needsSaving = true;
            }

            // Ensure message_ids array exists for tracking sent messages
            if (!Array.isArray(history.message_ids)) {
                history.message_ids = [];
                needsSaving = true;
            }

            if (needsSaving) {
                await this.saveChannelHistory(channelId, history);
                this.logger.info(`🔄 Migrated history format for ${channelId}`);
            }

            return history;
        } catch (error) {
            // Return fresh history structure with message_ids
            return { posted_media: [], last_posted: null, message_ids: [] };
        }
    }

    async saveChannelHistory(channelId, history) {
        try {
            const historyFolder = this.globalSettings.history_folder || 'history';
            const cleanChannelId = channelId.replace(/[@-]/g, '_');
            const historyFile = path.join(historyFolder, `${cleanChannelId}_history.json`);

            await fs.writeFile(historyFile, JSON.stringify(history, null, 2));
            return true;
        } catch (error) {
            this.logger.error(`❌ Error saving history for ${channelId}: ${error.message}`);
            return false;
        }
    }

    async getNextMediaForChannel(channelId) {
        const promoFolder = this.globalSettings.promo_folder || 'assets/promo';
        const channelConfig = this.channels[channelId];
        
        // Determine folder to use: channel-specific folder or promo folder
        let targetFolder = promoFolder;
        
        // Check if channel has specific folder configured
        if (channelConfig.image_folder && channelConfig.image_folder.startsWith('assets/')) {
            targetFolder = channelConfig.image_folder;
        } else {
            // Try to auto-detect based on channel name
            const channelName = channelConfig?.name?.toLowerCase()?.replace(/[^a-z0-9]/g, '');
            if (channelName) {
                const potentialFolder = path.join('assets', channelName);
                try {
                    await fs.access(potentialFolder);
                    targetFolder = potentialFolder;
                } catch (error) {
                    // Folder doesn't exist, will use promo folder
                }
            }
        }

        // Helper function to get valid media files from a folder
        const getValidMediaFromFolder = async (folderPath) => {
            try {
                const files = await fs.readdir(folderPath);
                const mediaExtensions = this.postingRules.media_formats || 
                                       ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.mp4', '.avi', '.mov', '.mkv'];
                
                const mediaFiles = files.filter(file => {
                    const ext = path.extname(file).toLowerCase();
                    return mediaExtensions.includes(ext);
                });

                const validFiles = [];
                for (const file of mediaFiles) {
                    const filePath = path.join(folderPath, file);
                    try {
                        const stats = await fs.stat(filePath);
                        const isVideo = this.isVideoFile(file);
                        const maxSize = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
                        
                        // File must be > 0 bytes and < max size
                        if (stats.size > 0 && stats.size < maxSize) {
                            validFiles.push({
                                file,
                                folder: folderPath,
                                isVideo,
                                mtime: stats.mtime
                            });
                        } else {
                            this.logger.debug(`⚠️ Skipping ${file}: size ${stats.size} bytes (valid range: 1 to ${maxSize})`);
                        }
                    } catch (error) {
                        this.logger.warn(`⚠️ Cannot access file ${file}: ${error.message}`);
                    }
                }
                
                return validFiles;
            } catch (error) {
                this.logger.warn(`⚠️ Cannot read folder ${folderPath}: ${error.message}`);
                return [];
            }
        };

        // Try to get valid media from target folder
        let validMediaFiles = await getValidMediaFromFolder(targetFolder);
        
        // If no valid files in channel folder and it's not promo folder, fallback to promo folder
        if (validMediaFiles.length === 0 && targetFolder !== promoFolder) {
            this.logger.info(`📁 No valid media in ${targetFolder}, falling back to ${promoFolder}`);
            validMediaFiles = await getValidMediaFromFolder(promoFolder);
            targetFolder = promoFolder;
        }

        if (validMediaFiles.length === 0) {
            this.logger.warn(`⚠️ No valid media files found for channel ${channelId} in any folder`);
            return { mediaPath: null, mediaFilename: null, isVideo: false };
        }

        this.logger.info(`📁 Using folder ${targetFolder} for ${channelId} (${validMediaFiles.length} valid files)`);

        // RANDOM SELECTION - Pick random file from valid files
        const randomIndex = Math.floor(Math.random() * validMediaFiles.length);
        const selectedFile = validMediaFiles[randomIndex];

        return {
            mediaPath: path.join(selectedFile.folder, selectedFile.file),
            mediaFilename: selectedFile.file,
            isVideo: selectedFile.isVideo
        };
    }

    async deleteOldMessages(channelId) {
        try {
            const history = await this.loadChannelHistory(channelId);
            const messageIds = history.message_ids || [];

            if (messageIds.length === 0) {
                return;
            }

            this.logger.info(`🗑️ Deleting ${messageIds.length} old message(s) from ${channelId}`);

            for (const messageId of messageIds) {
                try {
                    await this.rateLimitedRequest(() => 
                        this.bot.api.deleteMessage(channelId, messageId)
                    );
                    this.logger.info(`✅ Deleted message ${messageId} from ${channelId}`);
                } catch (error) {
                    // Message may be too old (>48h) or already deleted - still clear it from history
                    if (error.message.includes('message to delete not found') || 
                        error.message.includes("message can't be deleted")) {
                        this.logger.debug(`🗑️ Message ${messageId} already gone from ${channelId}, clearing from history`);
                    } else {
                        this.logger.warn(`⚠️ Could not delete message ${messageId}: ${error.message}`);
                    }
                }
            }

            // Always clear message_ids after processing, regardless of deletion success
            // This prevents accumulating stale message IDs that can't be deleted (>48h old)
            history.message_ids = [];
            await this.saveChannelHistory(channelId, history);

        } catch (error) {
            this.logger.error(`❌ Error deleting old messages from ${channelId}: ${error.message}`);
        }
    }

    async sendMediaToChannel(channelId) {
        if (!this.channels[channelId]) {
            this.logger.error(`❌ Channel config not found: ${channelId}`);
            return false;
        }

        const channelConfig = this.channels[channelId];

        // Define variables outside try block to ensure they're accessible in catch block
        let mediaPath = null;
        let mediaFilename = null;
        let isVideo = false;

        try {
            // Delete old messages before sending new one
            await this.deleteOldMessages(channelId);

            const mediaResult = await this.getNextMediaForChannel(channelId);
            mediaPath = mediaResult.mediaPath;
            mediaFilename = mediaResult.mediaFilename;
            isVideo = mediaResult.isVideo;

            if (!mediaPath) {
                this.logger.error(`❌ No media available for channel ${channelId}`);
                return false;
            }

            // Check file size first
            const stats = await fs.stat(mediaPath);
            const maxSize = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024; // 50MB for video, 10MB for images

            if (stats.size > maxSize) {
                this.logger.warn(`⚠️ ${isVideo ? 'Video' : 'Image'} ${mediaFilename} is too large (${Math.round(stats.size / 1024 / 1024)}MB), skipping...`);
                // Mark as posted to skip in next iteration
                const history = await this.loadChannelHistory(channelId);
                const postedMedia = history.posted_media || [];
                if (!postedMedia.includes(mediaFilename)) {
                    postedMedia.push(mediaFilename);
                    history.posted_media = postedMedia;
                    await this.saveChannelHistory(channelId, history);
                }
                return false;
            }

            // Create inline keyboard - support both old and new format
            let keyboard = null;

            // New format: multiple buttons (array)
            if (channelConfig.buttons && Array.isArray(channelConfig.buttons) && channelConfig.buttons.length > 0) {
                keyboard = new InlineKeyboard();
                channelConfig.buttons.forEach(btn => {
                    keyboard.url(btn.text, btn.url).row();
                });
            } 
            // Old format: single button (backward compatibility)
            else if (channelConfig.button_text && channelConfig.button_url) {
                keyboard = new InlineKeyboard();
                keyboard.url(channelConfig.button_text, channelConfig.button_url);
            }

            // Send media based on type dengan rate limiting
            let sentMessage;
            if (isVideo) {
                sentMessage = await this.rateLimitedRequest(() => 
                    this.bot.api.sendVideo(channelId, new InputFile(mediaPath), {
                        caption: channelConfig.promo_text,
                        parse_mode: this.postingRules.parse_mode || 'Markdown',
                        reply_markup: keyboard
                    })
                );
            } else {
                sentMessage = await this.rateLimitedRequest(() =>
                    this.bot.api.sendPhoto(channelId, new InputFile(mediaPath), {
                        caption: channelConfig.promo_text,
                        parse_mode: this.postingRules.parse_mode || 'Markdown',
                        reply_markup: keyboard
                    })
                );
            }

            // Save message_id for future deletion
            const history = await this.loadChannelHistory(channelId);
            const postedMedia = history.posted_media || [];

            if (!postedMedia.includes(mediaFilename)) {
                postedMedia.push(mediaFilename);
                history.posted_media = postedMedia;
            }

            // Accumulate message_ids so all sent messages can be deleted later
            if (!Array.isArray(history.message_ids)) history.message_ids = [];
            history.message_ids.push(sentMessage.message_id);
            history.last_posted = new Date().toISOString();
            await this.saveChannelHistory(channelId, history);

            this.logger.info(`📤 ${isVideo ? 'Video' : 'Image'} sent successfully to ${channelConfig.name}: ${mediaFilename} (message_id: ${sentMessage.message_id})`);
            return true;

        } catch (error) {
            this.logger.error(`❌ Error sending media to ${channelId}: ${error.message}`);

            // CHAT_RESTRICTED means the channel is restricted, not a file problem - don't mark file
            if (error.message.includes('CHAT_RESTRICTED')) {
                this.logger.warn(`⚠️ Channel ${channelId} is restricted - skipping for today to prevent retry loop`);
                return 'restricted';
            }

            // Mark problematic FILES as posted to avoid retry loop (only for actual file issues)
            if (mediaFilename && (
                error.message.includes('Request Entity Too Large') || 
                error.message.includes('wrong remote file identifier') ||
                error.message.includes('PHOTO_INVALID_DIMENSIONS') ||
                error.message.includes('DOCUMENT_INVALID')
            )) {
                this.logger.warn(`⚠️ Skipping ${mediaFilename} due to file issue`);

                const history = await this.loadChannelHistory(channelId);
                const postedMedia = history.posted_media || [];
                if (!postedMedia.includes(mediaFilename)) {
                    postedMedia.push(mediaFilename);
                    history.posted_media = postedMedia;
                    await this.saveChannelHistory(channelId, history);
                }
            }

            return false;
        }
    }

    getDateInTimezone(date, timezone) {
        // Convert a Date to a date string in the specified timezone
        // Returns 'YYYY-MM-DD' string in the given timezone
        try {
            const options = { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' };
            const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
            const year = parts.find(p => p.type === 'year').value;
            const month = parts.find(p => p.type === 'month').value;
            const day = parts.find(p => p.type === 'day').value;
            return `${year}-${month}-${day}`;
        } catch (e) {
            // Fallback to UTC if timezone is invalid
            return date.toISOString().split('T')[0];
        }
    }

    getTimeInTimezone(date, timezone) {
        // Get hour and minute in the specified timezone
        try {
            const options = { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false };
            const timeStr = new Intl.DateTimeFormat('en-GB', options).format(date);
            const [h, m] = timeStr.split(':').map(Number);
            return { hour: h, minute: m };
        } catch (e) {
            return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
        }
    }

    shouldPost(channelId, currentTime, schedule) {
        try {
            // Validate posting_time format
            if (!schedule.posting_time || !schedule.posting_time.match(/^\d{1,2}:\d{2}$/)) {
                this.logger.warn(`⚠️ Invalid posting_time format for ${channelId}: ${schedule.posting_time}`);
                return false;
            }

            const [targetHour, targetMinute] = schedule.posting_time.split(':').map(Number);

            // Validate hour and minute ranges
            if (targetHour < 0 || targetHour > 23 || targetMinute < 0 || targetMinute > 59) {
                this.logger.warn(`⚠️ Invalid time values for ${channelId}: ${targetHour}:${targetMinute}`);
                return false;
            }

            // Use channel's timezone to get current hour/minute (not server timezone)
            const channelTimezone = schedule.timezone || 'Asia/Jakarta';
            const { hour: currentHour, minute: currentMinute } = this.getTimeInTimezone(currentTime, channelTimezone);

            // Check if current time (in channel timezone) is past posting time
            const currentTotalMinutes = currentHour * 60 + currentMinute;
            const targetTotalMinutes = targetHour * 60 + targetMinute;

            if (currentTotalMinutes < targetTotalMinutes) {
                return false;
            }

            // Compare dates in channel's timezone (not server's UTC)
            const todayInChannelTz = this.getDateInTimezone(currentTime, channelTimezone);
            const lastRunInChannelTz = schedule.last_run 
                ? this.getDateInTimezone(new Date(schedule.last_run), channelTimezone)
                : null;

            const shouldPost = lastRunInChannelTz !== todayInChannelTz;

            if (shouldPost) {
                this.logger.debug(`📅 Should post to ${channelId}: current=${currentHour}:${String(currentMinute).padStart(2,'0')} ${channelTimezone}, scheduled=${schedule.posting_time}, todayTz=${todayInChannelTz}, lastRunTz=${lastRunInChannelTz}`);
            }

            return shouldPost;
        } catch (error) {
            this.logger.error(`❌ Error in shouldPost for ${channelId}: ${error.message}`);
            return false;
        }
    }

    async checkAndPost() {
        const currentTime = new Date();
        this.postingLocks = this.postingLocks || new Set();

        for (const [channelId, channelConfig] of Object.entries(this.channels)) {
            if (!channelConfig.enabled) continue;

            // Skip if already posting to this channel
            if (this.postingLocks.has(channelId)) {
                this.logger.debug(`⏳ Channel ${channelId} is already being processed, skipping...`);
                continue;
            }

            try {
                const schedule = {
                    posting_time: channelConfig.posting_time,
                    last_run: channelConfig.last_run || null,
                    timezone: channelConfig.timezone || 'Asia/Jakarta'
                };

                if (this.shouldPost(channelId, currentTime, schedule)) {
                    // Lock this channel to prevent duplicate posting
                    this.postingLocks.add(channelId);

                    this.logger.info(`⏰ Posting time for ${channelConfig.name} (${channelId})`);

                    try {
                        const result = await this.sendMediaToChannel(channelId);

                        if (result === true) {
                            channelConfig.last_run = currentTime.toISOString();
                            await this.saveConfig();
                            this.logger.info(`✅ Posting successful for ${channelConfig.name}`);
                        } else if (result === 'restricted') {
                            // Channel restricted — update last_run to prevent retrying every minute today
                            channelConfig.last_run = currentTime.toISOString();
                            await this.saveConfig();
                            this.logger.warn(`⏭️ Skipped ${channelConfig.name} today (channel restricted)`);
                        } else {
                            this.logger.error(`❌ Posting failed for ${channelConfig.name}`);
                        }
                    } catch (postError) {
                        this.logger.error(`❌ Error posting to ${channelId}: ${postError.message}`);
                    } finally {
                        // Always unlock this channel
                        this.postingLocks.delete(channelId);
                    }

                    // Delay between channels - cukup 1 detik karena sudah ada rate limiter
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (error) {
                this.postingLocks.delete(channelId); // Ensure unlock on error
                this.logger.error(`❌ Error checking posting for channel ${channelId}: ${error.message}`);
            }
        }
    }

    async sendChannelListPaginated(ctx, page = 0) {
        const activeChannels = Object.entries(this.channels)
            .filter(([_, config]) => config.enabled)
            .sort((a, b) => a[1].posting_time.localeCompare(b[1].posting_time));

        const itemsPerPage = 10;
        const totalPages = Math.ceil(activeChannels.length / itemsPerPage);

        // Validate page number
        if (page < 0) page = 0;
        if (page >= totalPages) page = totalPages - 1;

        const start = page * itemsPerPage;
        const end = Math.min(start + itemsPerPage, activeChannels.length);
        const pageChannels = activeChannels.slice(start, end);

        let listText = `📋 **DAFTAR CHANNEL** (Halaman ${page + 1}/${totalPages})\n`;
        listText += `Total: ${activeChannels.length} channels active\n\n`;

        for (const [channelId, config] of pageChannels) {
            const lastRun = config.last_run ? 
                new Date(config.last_run).toLocaleString('id-ID', { 
                    day: '2-digit', 
                    month: 'short', 
                    hour: '2-digit', 
                    minute: '2-digit' 
                }) : 'Never';

            listText += `🟢 **${config.name}**\n`;
            listText += `   ID: \`${channelId}\`\n`;
            listText += `   ⏰ Time: ${config.posting_time}\n`;
            listText += `   📤 Last: ${lastRun}\n\n`;
        }

        listText += `\n💡 Gunakan: \`!post @channelid\` untuk posting manual`;

        // Create navigation keyboard
        const keyboard = new InlineKeyboard();

        if (totalPages > 1) {
            if (page > 0) {
                keyboard.text('◀️ Previous', `channels_page_${page - 1}`);
            }
            keyboard.text(`${page + 1}/${totalPages}`, 'noop');
            if (page < totalPages - 1) {
                keyboard.text('Next ▶️', `channels_page_${page + 1}`);
            }
        }

        try {
            await ctx.reply(listText, { 
                parse_mode: 'Markdown',
                reply_markup: totalPages > 1 ? keyboard : undefined
            });
        } catch (error) {
            this.logger.error(`❌ Error sending channel list: ${error.message}`);
            await ctx.reply('❌ Error displaying channel list. Please try again.');
        }
    }

    async sendFolderListPaginated(ctx, page = 0) {
        const allChannels = Object.entries(this.channels);
        const itemsPerPage = 15;
        const totalPages = Math.ceil(allChannels.length / itemsPerPage);

        // Validate page number
        if (page < 0) page = 0;
        if (page >= totalPages) page = totalPages - 1;

        const start = page * itemsPerPage;
        const end = Math.min(start + itemsPerPage, allChannels.length);
        const pageChannels = allChannels.slice(start, end);

        let folderList = `📁 **CHANNEL FOLDERS** (Halaman ${page + 1}/${totalPages})\n\n`;

        for (const [channelId, channelConfig] of pageChannels) {
            const folder = channelConfig.image_folder || 'assets/promo (default)';
            folderList += `• **${channelConfig.name}**: \`${folder}\`\n`;
        }

        // Create navigation keyboard
        const keyboard = new InlineKeyboard();

        if (totalPages > 1) {
            if (page > 0) {
                keyboard.text('◀️ Previous', `folders_page_${page - 1}`);
            }
            keyboard.text(`${page + 1}/${totalPages}`, 'noop');
            if (page < totalPages - 1) {
                keyboard.text('Next ▶️', `folders_page_${page + 1}`);
            }
        }

        try {
            await ctx.reply(folderList, { 
                parse_mode: 'Markdown',
                reply_markup: totalPages > 1 ? keyboard : undefined
            });
        } catch (error) {
            this.logger.error(`❌ Error sending folder list: ${error.message}`);
            await ctx.reply('❌ Error displaying folder list. Please try again.');
        }
    }

    setupScheduler() {
        // Check every minute for posting
        const checkInterval = this.postingRules.check_interval || 60;

        this.scheduledTasks.set('main', cron.schedule(`*/${Math.ceil(checkInterval/60)} * * * *`, () => {
            this.checkAndPost();
        }, { scheduled: false }));

        // Daily cleanup at 2 AM
        this.scheduledTasks.set('cleanup', cron.schedule('0 2 * * *', () => {
            this.cleanupOldFiles();
        }, { scheduled: false }));

        // Cleanup pending uploads every 30 minutes
        this.scheduledTasks.set('memory-cleanup', cron.schedule('*/30 * * * *', () => {
            this.cleanupMemory();
        }, { scheduled: false }));

        this.logger.info(`🔄 Scheduler setup with ${checkInterval} second interval`);
        this.logger.info(`🧹 Daily cleanup scheduled at 02:00`);
        this.logger.info(`🧠 Memory cleanup scheduled every 30 minutes`);
    }

    cleanupMemory() {
        try {
            // Cleanup expired pending uploads (older than 10 minutes)
            const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
            let cleanedUploads = 0;
            let cleanedTimeouts = 0;

            if (this.pendingUploads) {
                this.pendingUploads.forEach((folderName, userId) => {
                    // This is a simple cleanup - in production, you'd want to track timestamps
                    // For now, we'll just limit the size
                    if (this.pendingUploads.size > 100) {
                        this.pendingUploads.delete(userId);
                        cleanedUploads++;
                    }
                });
            }

            if (this.uploadTimeouts) {
                this.uploadTimeouts.forEach((timeoutId, userId) => {
                    if (this.uploadTimeouts.size > 100) {
                        clearTimeout(timeoutId);
                        this.uploadTimeouts.delete(userId);
                        cleanedTimeouts++;
                    }
                });
            }

            if (cleanedUploads > 0 || cleanedTimeouts > 0) {
                this.logger.info(`🧠 Memory cleanup: ${cleanedUploads} uploads, ${cleanedTimeouts} timeouts cleared`);
            }
        } catch (error) {
            this.logger.error(`❌ Memory cleanup error: ${error.message}`);
        }
    }

    async cleanupOldFiles() {
        try {
            const maxDays = this.globalSettings.max_history_days || 7;
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - maxDays);

            // Cleanup history files
            const historyFolder = this.globalSettings.history_folder || 'history';
            const historyFiles = await fs.readdir(historyFolder);

            let cleanedHistory = 0;
            for (const file of historyFiles) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(historyFolder, file);
                    try {
                        const stats = await fs.stat(filePath);
                        if (stats.mtime < cutoffDate) {
                            await fs.unlink(filePath);
                            cleanedHistory++;
                        }
                    } catch (error) {
                        // File might not exist, continue
                    }
                }
            }

            // Cleanup log files
            const logsFolder = this.globalSettings.logs_folder || 'logs';
            try {
                const logFiles = await fs.readdir(logsFolder);
                let cleanedLogs = 0;

                for (const file of logFiles) {
                    if (file.endsWith('.log')) {
                        const filePath = path.join(logsFolder, file);
                        try {
                            const stats = await fs.stat(filePath);
                            if (stats.mtime < cutoffDate) {
                                await fs.unlink(filePath);
                                cleanedLogs++;
                            }
                        } catch (error) {
                            // File might not exist, continue
                        }
                    }
                }

                this.logger.info(`🧹 Cleanup completed: ${cleanedHistory} history files, ${cleanedLogs} log files removed`);
            } catch (error) {
                this.logger.warn(`⚠️ Log cleanup skipped: ${error.message}`);
            }

        } catch (error) {
            this.logger.error(`❌ Cleanup error: ${error.message}`);
        }
    }

    setupErrorHandler() {
        // Set global error handler
        this.bot.catch((err) => {
            this.logger.error(`❌ Bot error: ${err.message}`);

            // Improved error logging with context
            if (err.ctx && err.ctx.update) {
                this.logger.error(`Error context - User: ${err.ctx.from?.id}, Chat: ${err.ctx.chat?.id}, Message: ${err.ctx.message?.text}`);
            }

            // Don't log full error object unless it's a critical error
            if (err.error_code >= 500) {
                this.logger.error(`Critical error details: ${JSON.stringify(err, null, 2)}`);
            }
        });

        // Add process error handlers
        process.on('uncaughtException', (error) => {
            this.logger.error(`❌ Uncaught Exception: ${error.message}`);
            this.logger.error(error.stack);
        });

        process.on('unhandledRejection', (reason, promise) => {
            this.logger.error(`❌ Unhandled Rejection at: ${promise}, reason: ${reason}`);
        });
    }

    // Validate admin access with improved error handling
    isAdmin(userId) {
        try {
            const adminIds = process.env.ADMIN_IDS ? 
                process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
            return adminIds.includes(userId);
        } catch (error) {
            this.logger.error(`❌ Error checking admin status: ${error.message}`);
            return false;
        }
    }

    // =============================================
    // MENU SYSTEM
    // =============================================

    async showMainMenu(ctx, edit = false) {
        const status = this.isRunning ? '🟢 Running' : '🔴 Stopped';
        const activeChannels = Object.values(this.channels).filter(c => c.enabled).length;

        const text =
            `🤖 *TELEGRAM BOT MANAGER*\n\n` +
            `📊 Status: ${status}\n` +
            `📡 Channel Aktif: *${activeChannels}*\n\n` +
            `Pilih menu di bawah ini:`;

        const keyboard = new InlineKeyboard()
            .text('📋 Daftar Channel', 'menu_channels').text('📁 Folder', 'menu_folders').row()
            .text('📊 Status Bot', 'menu_status').text('⚙️ Kontrol', 'menu_control').row()
            .text('📤 Posting', 'menu_posting').text('🗑️ Hapus Pesan', 'menu_delete').row()
            .text('➕ Tambah Channel', 'menu_add_ch').text('➖ Hapus Channel', 'menu_remove_ch').row()
            .text('🖼️ Kelola Media', 'menu_media');

        const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
        if (edit) {
            await ctx.editMessageText(text, opts);
        } else {
            await ctx.reply(text, opts);
        }
    }

    async showChannelListMenu(ctx, page = 0) {
        const allChannels = Object.entries(this.channels);
        const itemsPerPage = 10;
        const totalPages = Math.ceil(allChannels.length / itemsPerPage);

        if (page < 0) page = 0;
        if (page >= totalPages) page = totalPages - 1;

        const start = page * itemsPerPage;
        const end = Math.min(start + itemsPerPage, allChannels.length);
        const pageChannels = allChannels.slice(start, end);

        let text = `📋 *DAFTAR CHANNEL* (${page + 1}/${totalPages})\n\n`;

        for (const [channelId, config] of pageChannels) {
            const lastRun = config.last_run
                ? new Date(config.last_run).toLocaleString('id-ID', {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                  })
                : 'Belum pernah';
            text += `🟢 *${config.name}*\n`;
            text += `   ⏰ ${config.posting_time} WIB  •  📤 ${lastRun}\n\n`;
        }

        const keyboard = new InlineKeyboard();
        if (totalPages > 1) {
            if (page > 0) keyboard.text('◀️ Prev', `menu_channels_p_${page - 1}`);
            keyboard.text(`${page + 1}/${totalPages}`, 'noop');
            if (page < totalPages - 1) keyboard.text('Next ▶️', `menu_channels_p_${page + 1}`);
            keyboard.row();
        }
        keyboard.text('◀️ Menu Utama', 'menu_main');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async showFolderListMenu(ctx, page = 0) {
        const allChannels = Object.entries(this.channels);
        const itemsPerPage = 12;
        const totalPages = Math.ceil(allChannels.length / itemsPerPage);

        if (page < 0) page = 0;
        if (page >= totalPages) page = totalPages - 1;

        const start = page * itemsPerPage;
        const end = Math.min(start + itemsPerPage, allChannels.length);
        const pageChannels = allChannels.slice(start, end);

        let text = `📁 *FOLDER CHANNEL* (${page + 1}/${totalPages})\n\n`;

        for (const [channelId, config] of pageChannels) {
            const folder = config.image_folder || 'assets/promo';
            text += `• *${config.name}*\n  \`${folder}\`\n\n`;
        }

        const keyboard = new InlineKeyboard();
        if (totalPages > 1) {
            if (page > 0) keyboard.text('◀️ Prev', `menu_folders_p_${page - 1}`);
            keyboard.text(`${page + 1}/${totalPages}`, 'noop');
            if (page < totalPages - 1) keyboard.text('Next ▶️', `menu_folders_p_${page + 1}`);
            keyboard.row();
        }
        keyboard.text('◀️ Menu Utama', 'menu_main');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async showStatusMenu(ctx, page = 0) {
        const status = this.isRunning ? '🟢 RUNNING' : '🔴 STOPPED';
        const allActive = Object.values(this.channels).filter(c => c.enabled && c.posting_time);
        const activeCount = allActive.length;
        const totalCount = Object.keys(this.channels).length;
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);

        const itemsPerPage = 12;
        const totalPages = Math.ceil(allActive.length / itemsPerPage);
        if (page < 0) page = 0;
        if (page >= totalPages) page = totalPages - 1;

        const pageChannels = allActive.slice(page * itemsPerPage, (page + 1) * itemsPerPage);

        let text =
            `📊 *STATUS BOT*\n\n` +
            `🤖 Status: ${status}\n` +
            `📡 Channel: *${activeCount}/${totalCount}* aktif\n` +
            `⏱️ Uptime: *${hours}j ${minutes}m*\n\n` +
            `⏰ *Jadwal Posting (${page + 1}/${totalPages}):*\n`;

        for (const ch of pageChannels) {
            const lastRun = ch.last_run
                ? new Date(ch.last_run).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
                : 'belum';
            text += `• *${ch.name}*: ${ch.posting_time} _(${lastRun})_\n`;
        }

        const keyboard = new InlineKeyboard();
        if (totalPages > 1) {
            if (page > 0) keyboard.text('◀️ Prev', `menu_status_p_${page - 1}`);
            keyboard.text(`${page + 1}/${totalPages}`, 'noop');
            if (page < totalPages - 1) keyboard.text('Next ▶️', `menu_status_p_${page + 1}`);
            keyboard.row();
        }
        keyboard.text('🔄 Refresh', `menu_status_p_${page}`).row();
        keyboard.text('◀️ Menu Utama', 'menu_main');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async showControlMenu(ctx) {
        const status = this.isRunning ? '🟢 Running' : '🔴 Stopped';

        const text =
            `⚙️ *KONTROL BOT*\n\n` +
            `Status saat ini: ${status}\n\n` +
            `Pilih aksi:`;

        const keyboard = new InlineKeyboard()
            .text('▶️ Start Scheduler', 'menu_ctrl_start').text('⏹️ Stop Scheduler', 'menu_ctrl_stop').row()
            .text('◀️ Menu Utama', 'menu_main');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async showPostingMenu(ctx) {
        const totalChannels = Object.values(this.channels).filter(c => c.enabled).length;

        const text =
            `📤 *MENU POSTING*\n\n` +
            `Total channel aktif: *${totalChannels}*\n\n` +
            `Pilih aksi:`;

        const keyboard = new InlineKeyboard()
            .text('🚀 Post ke Semua Channel', 'menu_postall_ask').row()
            .text('◀️ Menu Utama', 'menu_main');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async showDeleteMenu(ctx) {
        const totalChannels = Object.values(this.channels).filter(c => c.enabled).length;

        const text =
            `🗑️ *MENU HAPUS PESAN*\n\n` +
            `Channel aktif: *${totalChannels}*\n\n` +
            `ℹ️ *Catatan penting:*\n` +
            `Bot Telegram hanya bisa menghapus pesan yang _ID-nya tersimpan di history_. ` +
            `Pesan lama yang dikirim sebelum sistem tracking aktif tidak bisa dihapus secara otomatis — itu keterbatasan API Telegram.\n\n` +
            `Mulai sekarang, semua ID pesan diakumulasi sehingga penghapusan makin bersih ke depannya.\n\n` +
            `Pilih aksi:`;

        const keyboard = new InlineKeyboard()
            .text('🗑️ Hapus Semua Pesan Tertracking', 'menu_deleteall_ask').row()
            .text('◀️ Menu Utama', 'menu_main');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async showMediaMenu(ctx) {
        const totalChannels = Object.values(this.channels).filter(c => c.enabled).length;

        const text =
            `🖼️ *KELOLA MEDIA*\n\n` +
            `Total channel: *${totalChannels}*\n\n` +
            `Pilih aksi:`;

        const keyboard = new InlineKeyboard()
            .text('➕ Upload Foto/Video ke Channel', 'menu_upload_pick_0').row()
            .text('◀️ Menu Utama', 'menu_main');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async showUploadChannelList(ctx, page = 0) {
        const allChannels = Object.entries(this.channels);
        const itemsPerPage = 8;
        const totalPages = Math.ceil(allChannels.length / itemsPerPage);

        if (page < 0) page = 0;
        if (page >= totalPages) page = totalPages - 1;

        const start = page * itemsPerPage;
        const end = Math.min(start + itemsPerPage, allChannels.length);
        const pageChannels = allChannels.slice(start, end);

        let text = `🖼️ *PILIH CHANNEL UNTUK UPLOAD* (${page + 1}/${totalPages})\n\nKlik channel tujuan:`;

        const keyboard = new InlineKeyboard();
        for (const [channelId, config] of pageChannels) {
            keyboard.text(config.name, `menu_upload_ch_${channelId}`).row();
        }

        if (totalPages > 1) {
            if (page > 0) keyboard.text('◀️ Prev', `menu_upload_pick_${page - 1}`);
            keyboard.text(`${page + 1}/${totalPages}`, 'noop');
            if (page < totalPages - 1) keyboard.text('Next ▶️', `menu_upload_pick_${page + 1}`);
            keyboard.row();
        }
        keyboard.text('◀️ Kembali', 'menu_media');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async showRemoveChannelList(ctx, page = 0) {
        const allChannels = Object.entries(this.channels);
        const itemsPerPage = 8;
        const totalPages = Math.ceil(allChannels.length / itemsPerPage);

        if (page < 0) page = 0;
        if (page >= totalPages) page = totalPages - 1;

        const start = page * itemsPerPage;
        const end = Math.min(start + itemsPerPage, allChannels.length);
        const pageChannels = allChannels.slice(start, end);

        let text = `➖ *HAPUS CHANNEL* (${page + 1}/${totalPages})\n\nKlik channel yang ingin dihapus:`;

        const keyboard = new InlineKeyboard();
        for (const [channelId, config] of pageChannels) {
            keyboard.text(`🗑 ${config.name}`, `menu_rm_ask_${channelId}`).row();
        }

        if (totalPages > 1) {
            if (page > 0) keyboard.text('◀️ Prev', `menu_remove_ch_p_${page - 1}`);
            keyboard.text(`${page + 1}/${totalPages}`, 'noop');
            if (page < totalPages - 1) keyboard.text('Next ▶️', `menu_remove_ch_p_${page + 1}`);
            keyboard.row();
        }
        keyboard.text('◀️ Menu Utama', 'menu_main');

        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    // =============================================
    // END MENU SYSTEM
    // =============================================

    async handleAddChannelStep(ctx, userId, text, conv) {
        const cancelNote = `\n\n_Ketik /cancel untuk batal_`;

        if (conv.step === 'channel_id') {
            // Validate channel ID format
            const id = text.trim();
            if (!id.startsWith('@') && !id.startsWith('-')) {
                await ctx.reply(`❌ Format salah. Channel ID harus diawali \`@\` (username) atau \`-100\` (group ID).\n\nCoba lagi:${cancelNote}`, { parse_mode: 'Markdown' });
                return;
            }
            if (this.channels[id]) {
                await ctx.reply(`⚠️ Channel \`${id}\` sudah ada di daftar.\n\nMasukkan ID lain:${cancelNote}`, { parse_mode: 'Markdown' });
                return;
            }
            this.conversationState.set(userId, { action: 'add_channel', step: 'name', data: { id } });
            await ctx.reply(`✅ ID: \`${id}\`\n\n📝 Masukkan *nama tampilan* channel:\n_(contoh: JavaPlay88 Official)_${cancelNote}`, { parse_mode: 'Markdown' });

        } else if (conv.step === 'name') {
            const name = text.trim();
            if (name.length < 2) {
                await ctx.reply(`❌ Nama terlalu pendek. Coba lagi:${cancelNote}`, { parse_mode: 'Markdown' });
                return;
            }
            this.conversationState.set(userId, { action: 'add_channel', step: 'posting_time', data: { ...conv.data, name } });
            await ctx.reply(`✅ Nama: *${name}*\n\n⏰ Masukkan *waktu posting* (format 24 jam):\n_(contoh: 13:00 atau 08:30)_${cancelNote}`, { parse_mode: 'Markdown' });

        } else if (conv.step === 'posting_time') {
            const time = text.trim();
            if (!/^\d{1,2}:\d{2}$/.test(time)) {
                await ctx.reply(`❌ Format waktu salah. Gunakan format \`HH:MM\`\n_(contoh: 13:00)_\n\nCoba lagi:${cancelNote}`, { parse_mode: 'Markdown' });
                return;
            }
            this.conversationState.set(userId, { action: 'add_channel', step: 'folder', data: { ...conv.data, posting_time: time } });
            const defaultFolder = conv.data.id.replace('@', '').toLowerCase();
            await ctx.reply(
                `✅ Waktu: *${time}* WIB\n\n` +
                `📁 Masukkan *nama folder* untuk media channel:\n_(contoh: \`${defaultFolder}\`)_\n` +
                `Folder akan dibuat di: \`assets/<nama_folder>\`${cancelNote}`,
                { parse_mode: 'Markdown' }
            );

        } else if (conv.step === 'folder') {
            const folderName = text.trim().replace(/[^a-zA-Z0-9_\-\.]/g, '').toLowerCase();
            if (!folderName) {
                await ctx.reply(`❌ Nama folder tidak valid. Gunakan huruf/angka saja.\n\nCoba lagi:${cancelNote}`, { parse_mode: 'Markdown' });
                return;
            }
            this.conversationState.set(userId, { action: 'add_channel', step: 'confirm', data: { ...conv.data, folder: folderName } });
            const d = { ...conv.data, folder: folderName };
            const folderPath = `assets/${folderName}`;

            const keyboard = new InlineKeyboard()
                .text('✅ Simpan Channel', `menu_add_ch_save_${userId}`).row()
                .text('❌ Batal', 'menu_main');

            await ctx.reply(
                `📋 *KONFIRMASI TAMBAH CHANNEL*\n\n` +
                `📡 ID: \`${d.id}\`\n` +
                `📝 Nama: *${d.name}*\n` +
                `⏰ Waktu: *${d.posting_time}* WIB\n` +
                `📁 Folder: \`${folderPath}\`\n\n` +
                `Apakah data sudah benar?`,
                { parse_mode: 'Markdown', reply_markup: keyboard }
            );
        }
    }

    setupBotCommands() {
        // Handle text messages for commands
        this.bot.on('message:text', async (ctx) => {
            const text = ctx.message.text?.trim();
            const userId = ctx.from.id;

            // Basic input validation
            if (!text || text.length > 500) {
                return; // Ignore empty or overly long messages
            }

            // Check if user is admin
            if (!this.isAdmin(userId)) {
                return; // Only admins can use commands
            }

            try {
                // ─── CONVERSATION STATE (multi-step menu) ─────────────────
                const conv = this.conversationState.get(userId);
                if (conv) {
                    if (text === '/cancel' || text === '!cancel') {
                        this.conversationState.delete(userId);
                        await this.showMainMenu(ctx, false);
                        return;
                    }

                    if (conv.action === 'add_channel') {
                        await this.handleAddChannelStep(ctx, userId, text, conv);
                        return;
                    }
                }
                // ─────────────────────────────────────────────────────────

                if (text === '/start' || text === '/menu' || text === '!menu') {
                    await this.showMainMenu(ctx, false);
                } else if (text.startsWith('!add ')) {
                    const folderName = text.substring(5).trim();
                    if (folderName) {
                        // Store the folder name for next media upload
                        this.pendingUploads = this.pendingUploads || new Map();
                        this.pendingUploads.set(userId, folderName);

                        await ctx.reply(`📁 Ready to receive media for folder: ${folderName}\nPlease send an image or video now.`);
                    } else {
                        await ctx.reply('❌ Please specify folder name: !add <folder_name>');
                    }
                } else if (text.startsWith('!setfolder ')) {
                    const parts = text.substring(11).trim().split(' ');
                    if (parts.length >= 2) {
                        const channelIdentifier = parts[0];
                        const folderName = parts.slice(1).join(' ');

                        // Find channel by name or ID
                        let targetChannel = null;
                        for (const [channelId, channelConfig] of Object.entries(this.channels)) {
                            if (channelId.includes(channelIdentifier) || 
                                channelConfig.name.toLowerCase().includes(channelIdentifier.toLowerCase())) {
                                targetChannel = { id: channelId, config: channelConfig };
                                break;
                            }
                        }

                        if (targetChannel) {
                            const folderPath = path.join('assets', folderName);
                            targetChannel.config.image_folder = folderPath;
                            await this.saveConfig();
                            await ctx.reply(`✅ Updated ${targetChannel.config.name} to use folder: ${folderPath}`);
                            this.logger.info(`🔧 Manual folder update: ${targetChannel.id} -> ${folderPath}`);
                        } else {
                            await ctx.reply(`❌ Channel not found: ${channelIdentifier}`);
                        }
                    } else {
                        await ctx.reply('❌ Usage: !setfolder <channel_name_or_id> <folder_name>');
                    }
                } else if (text === '!folders' || text === '!listfolders') {
                    await this.sendFolderListPaginated(ctx, 0);
                } else if (text === '/help' || text === '!help') {
                    // Improved help text with better formatting and copyable commands
                    const helpText = `🤖 **TELEGRAM MULTI-CHANNEL BOT**\n` +
                        `🔥 **PANDUAN LENGKAP & COMMAND LIST**\n\n` +
                        `═══════════════════════════════════\n\n` +
                        `🔧 **MANAJEMEN KONTEN**\n` +
                        `┌─────────────────────────────────┐\n` +
                        `│ \`!add [nama]\` - Tambah media    │\n` +
                        `│ \`!folders\` - Lihat daftar folder│\n` +
                        `│ \`!setfolder [ch] [folder]\` - Set│\n` +
                        `└─────────────────────────────────┘\n\n` +
                        `📤 **POSTING & HAPUS**\n` +
                        `┌─────────────────────────────────┐\n` +
                        `│ \`!post @channel\` - Post manual  │\n` +
                        `│ \`!postall\` - Post ke semua      │\n` +
                        `│ \`!delete @channel\` - Hapus pesan│\n` +
                        `│ \`!deleteall\` - Hapus semua pesan│\n` +
                        `└─────────────────────────────────┘\n\n` +
                        `📋 **INFO & STATUS**\n` +
                        `┌─────────────────────────────────┐\n` +
                        `│ \`!list\` - Lihat semua channel   │\n` +
                        `│ \`!status\` - Cek status bot      │\n` +
                        `│ \`!channels\` - Alias dari !list  │\n` +
                        `└─────────────────────────────────┘\n\n` +
                        `⚙️ **KONTROL BOT**\n` +
                        `┌─────────────────────────────────┐\n` +
                        `│ \`!start\` - Mulai scheduler      │\n` +
                        `│ \`!stop\` - Stop scheduler        │\n` +
                        `│ \`/help\` - Tampilkan help ini    │\n` +
                        `└─────────────────────────────────┘\n\n` +
                        `📋 **CONTOH PENGGUNAAN:**\n\n` +
                        `➤ Upload gambar baru:\n` +
                        `   \`!add ihokibet\`\n` +
                        `   _(lalu kirim foto/video)_\n\n` +
                        `➤ Posting manual:\n` +
                        `   \`!post @ihokibet\`\n\n` +
                        `➤ Hapus pesan lama:\n` +
                        `   \`!delete @ihokibet\`\n\n` +
                        `➤ Set folder channel:\n` +
                        `   \`!setfolder ihokibet promo\`\n\n` +
                        `══════════════════════════════════\n` +
                        `🎯 **QUICK COMMANDS (TAP TO COPY):**\n\n` +
                        `\`!list\` \`!folders\` \`!start\` \`!stop\`\n` +
                        `\`!status\` \`!postall\` \`!delete\` \`/help\`\n\n` +
                        `📄 **CATATAN:**\n` +
                        `Output panjang seperti \`!list\` dan \`!folders\`\n` +
                        `akan dikirim dalam beberapa halaman\n\n` +
                        `💡 _Tap & hold command untuk copy!_\n` +
                        `⚠️ _Hanya Admin yang bisa gunakan bot_`;

                    await ctx.reply(helpText, { parse_mode: 'Markdown' });
                } else if (text === '!start') {
                    if (!this.isRunning) {
                        this.setupScheduler();
                        this.scheduledTasks.get('main').start();
                        this.scheduledTasks.get('cleanup').start();
                        this.scheduledTasks.get('memory-cleanup').start();
                        this.isRunning = true;
                        await ctx.reply('✅ Bot scheduler telah dimulai!');
                        this.logger.info(`🚀 Bot scheduler started manually by admin ${userId}`);
                    } else {
                        await ctx.reply('⚠️ Bot scheduler sudah berjalan!');
                    }
                } else if (text === '!stop') {
                    if (this.isRunning) {
                        this.scheduledTasks.forEach(task => task.stop());
                        this.isRunning = false;
                        await ctx.reply('🛑 Bot scheduler telah dihentikan!');
                        this.logger.info(`🛑 Bot scheduler stopped manually by admin ${userId}`);
                    } else {
                        await ctx.reply('⚠️ Bot scheduler sudah tidak berjalan!');
                    }
                } else if (text === '!status') {
                    const status = this.isRunning ? '🟢 RUNNING' : '🔴 STOPPED';
                    const activeChannels = Object.values(this.channels).filter(c => c.enabled).length;
                    const totalChannels = Object.keys(this.channels).length;

                    let statusText = `🤖 Bot Status: ${status}\n\n`;
                    statusText += `📊 Statistics:\n`;
                    statusText += `• Active Channels: ${activeChannels}/${totalChannels}\n`;
                    statusText += `• Scheduler: ${this.isRunning ? 'Active' : 'Inactive'}\n`;
                    statusText += `• Uptime: ${process.uptime().toFixed(0)} seconds\n\n`;

                    if (this.isRunning) {
                        statusText += `⏰ Next Posting Times:\n`;
                        const channels = Object.values(this.channels)
                            .filter(c => c.enabled && c.posting_time)
                            .slice(0, 5);

                        for (const channel of channels) {
                            statusText += `• ${channel.name}: ${channel.posting_time}\n`;
                        }
                    }

                    await ctx.reply(statusText);
                } else if (text.startsWith('!post ')) {
                    const channelId = text.substring(6).trim();
                    if (this.channels[channelId]) {
                        await ctx.reply(`🚀 Force posting to ${this.channels[channelId].name}...`);
                        const success = await this.forcePostChannel(channelId);
                        if (success) {
                            await ctx.reply(`✅ Successfully posted to ${this.channels[channelId].name}`);
                        } else {
                            await ctx.reply(`❌ Failed to post to ${this.channels[channelId].name}`);
                        }
                    } else {
                        await ctx.reply(`❌ Channel not found: ${channelId}`);
                    }
                } else if (text === '!postall') {
                    await ctx.reply(`🚀 Force posting to all channels...`);
                    const results = await this.forcePostAll();
                    const successCount = Object.values(results).filter(Boolean).length;
                    const totalCount = Object.keys(results).length;
                    await ctx.reply(`✅ Completed: ${successCount}/${totalCount} channels posted successfully`);
                } else if (text.startsWith('!delete ')) {
                    const channelId = text.substring(8).trim();
                    if (this.channels[channelId]) {
                        await ctx.reply(`🗑️ Deleting old messages from ${this.channels[channelId].name}...`);
                        await this.deleteOldMessages(channelId);
                        await ctx.reply(`✅ Old messages deleted from ${this.channels[channelId].name}`);
                    } else {
                        await ctx.reply(`❌ Channel not found: ${channelId}`);
                    }
                } else if (text === '!deleteall') {
                    await ctx.reply(`🗑️ Deleting all old messages from all channels...`);
                    let deletedCount = 0;
                    for (const channelId of Object.keys(this.channels)) {
                        if (this.channels[channelId].enabled) {
                            await this.deleteOldMessages(channelId);
                            deletedCount++;
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                    await ctx.reply(`✅ Deleted old messages from ${deletedCount} channels`);
                } else if (text === '!list' || text === '!channels') {
                    await this.sendChannelListPaginated(ctx, 0);
                }
            } catch (error) {
                this.logger.error(`❌ Error handling command "${text}": ${error.message}`);
                // Safe error reply without special characters
                const safeErrorMsg = `❌ Error processing command: ${error.message.replace(/[*_`[\]()~>#+=|{}.!-]/g, '')}`;
                try {
                    await ctx.reply(safeErrorMsg);
                } catch (replyError) {
                    this.logger.error(`❌ Failed to send error reply: ${replyError.message}`);
                    // Fallback to simple message
                    try {
                        await ctx.reply('❌ Command error occurred. Check logs for details.');
                    } catch (fallbackError) {
                        this.logger.error(`❌ All reply attempts failed: ${fallbackError.message}`);
                    }
                }
            }
        });

        // Handle callback queries (button clicks)
        this.bot.on('callback_query:data', async (ctx) => {
            const data = ctx.callbackQuery.data;
            const userId = ctx.from.id;

            // Check if user is admin
            if (!this.isAdmin(userId)) {
                await ctx.answerCallbackQuery('⛔ Only admins can use this bot');
                return;
            }

            try {
                await ctx.answerCallbackQuery();

                // ─── MENU SYSTEM CALLBACKS ───────────────────────────────

                if (data === 'menu_main') {
                    await this.showMainMenu(ctx, true);

                } else if (data === 'menu_channels') {
                    await this.showChannelListMenu(ctx, 0);

                } else if (data.startsWith('menu_channels_p_')) {
                    const page = parseInt(data.replace('menu_channels_p_', ''));
                    await this.showChannelListMenu(ctx, page);

                } else if (data === 'menu_folders') {
                    await this.showFolderListMenu(ctx, 0);

                } else if (data.startsWith('menu_folders_p_')) {
                    const page = parseInt(data.replace('menu_folders_p_', ''));
                    await this.showFolderListMenu(ctx, page);

                } else if (data === 'menu_status') {
                    await this.showStatusMenu(ctx, 0);

                } else if (data.startsWith('menu_status_p_')) {
                    const page = parseInt(data.replace('menu_status_p_', ''));
                    await this.showStatusMenu(ctx, page);

                } else if (data === 'menu_control') {
                    await this.showControlMenu(ctx);

                } else if (data === 'menu_ctrl_start') {
                    if (!this.isRunning) {
                        this.setupScheduler();
                        this.scheduledTasks.get('main').start();
                        this.scheduledTasks.get('cleanup').start();
                        this.scheduledTasks.get('memory-cleanup').start();
                        this.isRunning = true;
                        this.logger.info(`🚀 Bot scheduler started via menu by admin ${userId}`);
                    }
                    await this.showControlMenu(ctx);

                } else if (data === 'menu_ctrl_stop') {
                    if (this.isRunning) {
                        this.scheduledTasks.forEach(task => task.stop());
                        this.isRunning = false;
                        this.logger.info(`🛑 Bot scheduler stopped via menu by admin ${userId}`);
                    }
                    await this.showControlMenu(ctx);

                } else if (data === 'menu_posting') {
                    await this.showPostingMenu(ctx);

                } else if (data === 'menu_postall_ask') {
                    const totalChannels = Object.values(this.channels).filter(c => c.enabled).length;
                    const keyboard = new InlineKeyboard()
                        .text(`✅ Ya, Post ke ${totalChannels} Channel`, 'menu_postall_run').row()
                        .text('❌ Batal', 'menu_posting');
                    await ctx.editMessageText(
                        `📤 *KONFIRMASI POSTING*\n\n` +
                        `Yakin ingin post ke semua *${totalChannels}* channel sekarang?`,
                        { parse_mode: 'Markdown', reply_markup: keyboard }
                    );

                } else if (data === 'menu_postall_run') {
                    const keyboard = new InlineKeyboard().text('⏳ Sedang memproses...', 'noop');
                    await ctx.editMessageText(
                        `🚀 *POSTING BERJALAN...*\n\nMohon tunggu, sedang posting ke semua channel.`,
                        { parse_mode: 'Markdown', reply_markup: keyboard }
                    );
                    const results = await this.forcePostAll();
                    const successCount = Object.values(results).filter(Boolean).length;
                    const totalCount = Object.keys(results).length;
                    const keyboard2 = new InlineKeyboard()
                        .text('◀️ Menu Posting', 'menu_posting').text('🏠 Menu Utama', 'menu_main');
                    await ctx.editMessageText(
                        `✅ *POSTING SELESAI*\n\n` +
                        `Berhasil: *${successCount}/${totalCount}* channel`,
                        { parse_mode: 'Markdown', reply_markup: keyboard2 }
                    );

                } else if (data === 'menu_delete') {
                    await this.showDeleteMenu(ctx);

                } else if (data === 'menu_deleteall_ask') {
                    const totalChannels = Object.values(this.channels).filter(c => c.enabled).length;
                    const keyboard = new InlineKeyboard()
                        .text(`✅ Ya, Hapus Semua Pesan`, 'menu_deleteall_run').row()
                        .text('❌ Batal', 'menu_delete');
                    await ctx.editMessageText(
                        `🗑️ *KONFIRMASI HAPUS*\n\n` +
                        `Yakin ingin hapus semua pesan lama dari *${totalChannels}* channel?\n\n` +
                        `⚠️ Pesan yang ada di Telegram akan dihapus permanen.`,
                        { parse_mode: 'Markdown', reply_markup: keyboard }
                    );

                } else if (data === 'menu_deleteall_run') {
                    const keyboard = new InlineKeyboard().text('⏳ Sedang menghapus...', 'noop');
                    await ctx.editMessageText(
                        `🗑️ *MENGHAPUS PESAN...*\n\nMohon tunggu, sedang menghapus pesan dari semua channel.`,
                        { parse_mode: 'Markdown', reply_markup: keyboard }
                    );
                    let deletedCount = 0;
                    let totalDeleted = 0;
                    for (const channelId of Object.keys(this.channels)) {
                        if (this.channels[channelId].enabled) {
                            const before = (await this.loadChannelHistory(channelId)).message_ids?.length || 0;
                            await this.deleteOldMessages(channelId);
                            totalDeleted += before;
                            deletedCount++;
                            await new Promise(resolve => setTimeout(resolve, 300));
                        }
                    }
                    const keyboard2 = new InlineKeyboard()
                        .text('◀️ Menu Hapus', 'menu_delete').text('🏠 Menu Utama', 'menu_main');
                    await ctx.editMessageText(
                        `✅ *HAPUS SELESAI*\n\n` +
                        `Selesai memproses *${deletedCount}* channel.\n` +
                        `Total pesan dihapus: *${totalDeleted}*`,
                        { parse_mode: 'Markdown', reply_markup: keyboard2 }
                    );

                // ─── CHANNEL MANAGEMENT ──────────────────────────────────

                } else if (data === 'menu_add_ch') {
                    this.conversationState.set(userId, { action: 'add_channel', step: 'channel_id', data: {} });
                    const keyboard = new InlineKeyboard().text('❌ Batal', 'menu_main');
                    await ctx.editMessageText(
                        `➕ *TAMBAH CHANNEL BARU*\n\n` +
                        `Kirim *ID channel* Telegram:\n` +
                        `• Username: \`@namachannel\`\n` +
                        `• Channel ID: \`-100xxxxxxxxx\`\n\n` +
                        `_Ketik /cancel untuk batal_`,
                        { parse_mode: 'Markdown', reply_markup: keyboard }
                    );

                } else if (data.startsWith('menu_add_ch_save_')) {
                    const targetUserId = parseInt(data.replace('menu_add_ch_save_', ''));
                    const convData = this.conversationState.get(targetUserId);
                    if (convData && convData.action === 'add_channel' && convData.step === 'confirm') {
                        const d = convData.data;
                        const folderPath = `assets/${d.folder}`;
                        const newChannel = {
                            id: d.id,
                            name: d.name,
                            posting_time: d.posting_time,
                            timezone: 'Asia/Jakarta',
                            image_folder: folderPath,
                            promo_text: `Selamat datang di ${d.name}! Kunjungi kami untuk informasi terbaru.`,
                            enabled: true,
                            buttons: [],
                            last_run: null
                        };
                        // Create folder
                        try { await fs.mkdir(folderPath, { recursive: true }); } catch (_) {}
                        // Add to channels
                        this.channels[d.id] = newChannel;
                        this.allChannels[d.id] = newChannel;
                        await this.saveConfig();
                        this.conversationState.delete(targetUserId);
                        this.logger.info(`➕ Channel added via menu: ${d.id} by admin ${userId}`);
                        const keyboard = new InlineKeyboard()
                            .text('📋 Lihat Daftar Channel', 'menu_channels').text('🏠 Menu Utama', 'menu_main');
                        await ctx.reply(
                            `✅ *CHANNEL BERHASIL DITAMBAHKAN!*\n\n` +
                            `📡 ID: \`${d.id}\`\n` +
                            `📝 Nama: *${d.name}*\n` +
                            `⏰ Waktu: *${d.posting_time}* WIB\n` +
                            `📁 Folder: \`${folderPath}\`\n\n` +
                            `⚠️ Jangan lupa upload foto/video ke folder tersebut dan atur promo text di config.`,
                            { parse_mode: 'Markdown', reply_markup: keyboard }
                        );
                    } else {
                        await ctx.reply('❌ Sesi expired. Silakan mulai lagi dari menu.');
                    }

                } else if (data === 'menu_remove_ch') {
                    await this.showRemoveChannelList(ctx, 0);

                } else if (data.startsWith('menu_remove_ch_p_')) {
                    const page = parseInt(data.replace('menu_remove_ch_p_', ''));
                    await this.showRemoveChannelList(ctx, page);

                } else if (data.startsWith('menu_rm_ask_')) {
                    const channelId = data.replace('menu_rm_ask_', '');
                    const ch = this.channels[channelId];
                    if (!ch) { await ctx.editMessageText('❌ Channel tidak ditemukan.'); return; }
                    const keyboard = new InlineKeyboard()
                        .text(`✅ Ya, Hapus "${ch.name}"`, `menu_rm_run_${channelId}`).row()
                        .text('❌ Batal', 'menu_remove_ch');
                    await ctx.editMessageText(
                        `🗑️ *KONFIRMASI HAPUS CHANNEL*\n\n` +
                        `Channel: *${ch.name}*\n` +
                        `ID: \`${channelId}\`\n\n` +
                        `⚠️ Channel akan dihapus dari daftar bot. Data history tetap tersimpan.`,
                        { parse_mode: 'Markdown', reply_markup: keyboard }
                    );

                } else if (data.startsWith('menu_rm_run_')) {
                    const channelId = data.replace('menu_rm_run_', '');
                    const ch = this.channels[channelId];
                    if (!ch) { await ctx.editMessageText('❌ Channel tidak ditemukan.'); return; }
                    const chName = ch.name;
                    delete this.channels[channelId];
                    delete this.allChannels[channelId];
                    await this.saveConfig();
                    this.logger.info(`➖ Channel removed via menu: ${channelId} by admin ${userId}`);
                    const keyboard = new InlineKeyboard()
                        .text('◀️ Lihat Daftar', 'menu_remove_ch').text('🏠 Menu Utama', 'menu_main');
                    await ctx.editMessageText(
                        `✅ *Channel dihapus!*\n\n*${chName}* (\`${channelId}\`) telah dihapus dari bot.`,
                        { parse_mode: 'Markdown', reply_markup: keyboard }
                    );

                // ─── MEDIA MANAGEMENT ─────────────────────────────────────

                } else if (data === 'menu_media') {
                    await this.showMediaMenu(ctx);

                } else if (data.startsWith('menu_upload_pick_')) {
                    const page = parseInt(data.replace('menu_upload_pick_', ''));
                    await this.showUploadChannelList(ctx, page);

                } else if (data.startsWith('menu_upload_ch_')) {
                    const channelId = data.replace('menu_upload_ch_', '');
                    const ch = this.channels[channelId];
                    if (!ch) { await ctx.editMessageText('❌ Channel tidak ditemukan.'); return; }
                    const folderPath = ch.image_folder || `assets/${channelId.replace('@', '')}`;
                    // Set pendingUpload for this user
                    this.pendingUploads.set(userId, path.basename(folderPath));
                    const keyboard = new InlineKeyboard().text('❌ Batal', 'menu_media');
                    await ctx.editMessageText(
                        `🖼️ *UPLOAD MEDIA*\n\n` +
                        `Channel: *${ch.name}*\n` +
                        `Folder: \`${folderPath}\`\n\n` +
                        `📤 Sekarang kirim *foto atau video* ke chat ini.\n` +
                        `_Bot akan menyimpannya ke folder channel._`,
                        { parse_mode: 'Markdown', reply_markup: keyboard }
                    );

                // ─── LEGACY PAGINATION CALLBACKS ─────────────────────────

                } else if (data.startsWith('channels_page_')) {
                    const page = parseInt(data.replace('channels_page_', ''));
                    await ctx.deleteMessage();
                    await this.sendChannelListPaginated(ctx, page);
                } else if (data.startsWith('folders_page_')) {
                    const page = parseInt(data.replace('folders_page_', ''));
                    await ctx.deleteMessage();
                    await this.sendFolderListPaginated(ctx, page);
                } else if (data === 'noop') {
                    // do nothing
                }

            } catch (error) {
                this.logger.error(`❌ Error handling callback query: ${error.message}`);
                try {
                    await ctx.answerCallbackQuery('❌ Error: ' + error.message.substring(0, 50));
                } catch (_) {}
            }
        });

        // Handle photo uploads
        this.bot.on('message:photo', async (ctx) => {
            await this.handleMediaUpload(ctx, 'photo');
        });

        // Handle video uploads
        this.bot.on('message:video', async (ctx) => {
            await this.handleMediaUpload(ctx, 'video');
        });

        // Handle document uploads (for other media formats)
        this.bot.on('message:document', async (ctx) => {
            const document = ctx.message.document;
            const mediaExtensions = this.postingRules.media_formats || 
                                   ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.mp4', '.avi', '.mov', '.mkv'];

            const fileExt = path.extname(document.file_name || '').toLowerCase();
            if (mediaExtensions.includes(fileExt)) {
                await this.handleMediaUpload(ctx, 'document');
            }
        });

        this.logger.info('🤖 Bot commands setup completed');
    }

    findChannelsForFolder(folderName) {
        const normalizedFolderName = folderName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const matchingChannels = [];

        for (const [channelId, channelConfig] of Object.entries(this.channels)) {
            const channelName = channelConfig.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            const channelIdClean = channelId.replace(/[@-]/g, '').toLowerCase();

            // Check if folder name matches channel name or channel ID
            if (channelName.includes(normalizedFolderName) || 
                normalizedFolderName.includes(channelName) ||
                channelIdClean.includes(normalizedFolderName) ||
                normalizedFolderName.includes(channelIdClean)) {
                matchingChannels.push(channelId);
            }
        }

        return matchingChannels;
    }

    async handleMediaUpload(ctx, mediaType) {
        const userId = ctx.from.id;

        // Check if user is admin
        if (!this.isAdmin(userId)) {
            return;
        }

        this.pendingUploads = this.pendingUploads || new Map();
        const folderName = this.pendingUploads.get(userId);

        if (!folderName) {
            await ctx.reply('❌ Please use !add <folder_name> command first before sending media.');
            return;
        }

        // Set timeout to cleanup pending uploads after 10 minutes
        if (!this.uploadTimeouts) {
            this.uploadTimeouts = new Map();
        }

        // Clear existing timeout for this user
        if (this.uploadTimeouts.has(userId)) {
            clearTimeout(this.uploadTimeouts.get(userId));
        }

        // Set new timeout
        const timeoutId = setTimeout(() => {
            this.pendingUploads.delete(userId);
            this.uploadTimeouts.delete(userId);
            this.logger.info(`🧹 Cleaned up pending upload for user ${userId}`);
        }, 10 * 60 * 1000); // 10 minutes

        this.uploadTimeouts.set(userId, timeoutId);

        try {
            let fileId, fileName;

            if (mediaType === 'photo') {
                const photos = ctx.message.photo;
                const largestPhoto = photos[photos.length - 1]; // Get highest resolution
                fileId = largestPhoto.file_id;
                fileName = `image_${Date.now()}.jpg`;
            } else if (mediaType === 'video') {
                fileId = ctx.message.video.file_id;
                fileName = ctx.message.video.file_name || `video_${Date.now()}.mp4`;
            } else if (mediaType === 'document') {
                fileId = ctx.message.document.file_id;
                fileName = ctx.message.document.file_name || `document_${Date.now()}`;
            }

            // Get file info from Telegram
            const file = await this.bot.api.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

            // Create folder if it doesn't exist
            const folderPath = path.join('assets', folderName);
            await fs.mkdir(folderPath, { recursive: true });

            // Download and save file with improved error handling
            const response = await fetch(fileUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const buffer = await response.arrayBuffer();
            const filePath = path.join(folderPath, fileName);

            await fs.writeFile(filePath, Buffer.from(buffer));

            // Try to find and update channel configuration automatically
            const matchingChannels = this.findChannelsForFolder(folderName);
            let updatedChannels = [];

            for (const channelId of matchingChannels) {
                if (this.channels[channelId] && 
                    (this.channels[channelId].image_folder === 'assets/promo' || 
                     this.channels[channelId].image_folder === this.globalSettings.promo_folder)) {

                    this.channels[channelId].image_folder = folderPath;
                    updatedChannels.push(this.channels[channelId].name);
                    this.logger.info(`🔧 Auto-updated ${channelId} to use folder: ${folderPath}`);
                }
            }

            if (updatedChannels.length > 0) {
                await this.saveConfig();
            }

            // Clear pending upload
            this.pendingUploads.delete(userId);
            if (this.uploadTimeouts.has(userId)) {
                clearTimeout(this.uploadTimeouts.get(userId));
                this.uploadTimeouts.delete(userId);
            }

            let replyMessage = `✅ Media uploaded successfully!\n📁 Folder: ${folderName}\n📄 File: ${fileName}\n📍 Path: ${filePath}`;

            if (updatedChannels.length > 0) {
                replyMessage += `\n\n🔧 Auto-configured channels:\n${updatedChannels.map(name => `• ${name}`).join('\n')}`;
            }

            await ctx.reply(replyMessage);

            this.logger.info(`📤 Media uploaded: ${filePath} by user ${userId}`);

        } catch (error) {
            this.logger.error(`❌ Error uploading media: ${error.message}`);
            await ctx.reply(`❌ Error uploading media: ${error.message}`);
        }
    }

    async start() {
        try {
            // Ensure bot is initialized before starting
            if (!this.isInitialized) {
                this.logger.warn('⚠️ Bot not initialized yet. Initializing now...');
                await this.init();
            }
            
            // Improved retry logic dengan exponential backoff
            let authenticated = false;
            let retryCount = 0;
            const maxRetries = 3; // 3 retry cukup untuk initial connection
            
            while (!authenticated && retryCount < maxRetries) {
                try {
                    this.logger.info(`🔄 Connecting to Telegram... (${retryCount + 1}/${maxRetries})`);
                    const me = await this.rateLimitedRequest(() => this.bot.api.getMe());
                    this.logger.info(`✅ Bot connected: ${me.first_name} (@${me.username})`);
                    authenticated = true;
                } catch (error) {
                    retryCount++;
                    if (retryCount < maxRetries) {
                        const waitTime = Math.min(3000 * Math.pow(2, retryCount), 30000); // 3s, 6s, 12s
                        this.logger.warn(`⚠️ Connection failed (${error.message}), waiting ${waitTime/1000}s...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else {
                        this.logger.error(`❌ Cannot connect after ${maxRetries} attempts`);
                        this.logger.error(`💡 Check: internet connection, bot token, firewall`);
                        throw error;
                    }
                }
            }

            // Setup bot commands
            await this.setupBotCommands();

            this.logger.info('🚀 Starting Telegram Multi-Channel Bot...');
            this.logger.info(`📋 Config loaded for ${Object.keys(this.channels).filter(id => this.channels[id].enabled).length} active channels`);

            await this.validateChannelAccess();

            this.setupScheduler();

            // Start schedulers
            this.scheduledTasks.get('main').start();
            this.scheduledTasks.get('cleanup').start();
            this.scheduledTasks.get('memory-cleanup').start();

            // Setup error handler for network issues
            this.setupBotErrorHandler();

            // Start bot polling for commands (non-blocking)
            this.startBotPolling();
            this.isRunning = true;

            // Setup connection health monitoring
            this.setupConnectionMonitoring();

            this.logger.info('✅ Bot started successfully');
            this.printScheduleSummary();

            // Keep process alive
            process.on('SIGINT', () => this.stop());
            process.on('SIGTERM', () => this.stop());

        } catch (error) {
            this.logger.error(`❌ Error starting bot: ${error.message}`);
            throw error;
        }
    }

    setupBotErrorHandler() {
        // Handle errors from bot polling and API calls
        this.bot.catch((err) => {
            const error = err.error || err;
            
            // Check if it's a network-related error
            const isNetworkError = 
                error.message?.includes('Network request') ||
                error.message?.includes('ECONNRESET') ||
                error.message?.includes('ETIMEDOUT') ||
                error.message?.includes('ENOTFOUND') ||
                error.message?.includes('fetch failed') ||
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ENOTFOUND';

            if (isNetworkError) {
                this.logger.warn(`⚠️ Network error detected: ${error.message}`);
                this.logger.info(`🔄 Bot will continue running and retry automatically...`);
                // Don't throw - let it retry automatically
            } else {
                this.logger.error(`❌ Bot error: ${error.message}`);
                if (error.stack) {
                    this.logger.error(`Stack trace: ${error.stack}`);
                }
            }
        });
    }

    startBotPolling() {
        // Start bot polling (non-blocking, runs in background)
        this.logger.info('🔄 Starting bot polling...');
        
        // bot.start() is a long-running task that polls for updates
        // It should not be awaited as it runs indefinitely
        this.bot.start({
            onStart: () => {
                this.logger.info('📡 Bot polling started successfully');
            }
        });
    }

    setupConnectionMonitoring() {
        // Monitor connection health every 10 minutes - kurangi beban
        const healthCheckInterval = setInterval(async () => {
            try {
                // Health check dengan rate limiting
                await this.rateLimitedRequest(() => this.bot.api.getMe());
                this.logger.debug('✅ Connection health check passed');
                
                // Reset consecutive failures counter
                if (!this.consecutiveFailures) this.consecutiveFailures = 0;
                this.consecutiveFailures = 0;
                
            } catch (error) {
                this.logger.warn(`⚠️ Connection health check failed: ${error.message}`);
                
                // Track consecutive failures
                if (!this.consecutiveFailures) this.consecutiveFailures = 0;
                this.consecutiveFailures++;
                
                if (this.consecutiveFailures >= 2) {
                    this.logger.error(`❌ Multiple consecutive health check failures (${this.consecutiveFailures})`);
                    this.logger.info('🔄 Attempting to reconnect bot...');
                    
                    // Try to reconnect dengan retry
                    try {
                        await this.rateLimitedRequest(() => this.bot.api.getMe());
                        this.logger.info('✅ Reconnection successful');
                        this.consecutiveFailures = 0;
                    } catch (reconnectError) {
                        this.logger.error(`❌ Reconnection failed: ${reconnectError.message}`);
                        this.logger.warn('⚠️ Bot may have connectivity issues. Will retry automatically.');
                    }
                } else {
                    this.logger.info('🔄 Bot will automatically retry on next request...');
                }
            }
        }, 10 * 60 * 1000); // Every 10 minutes - kurangi frequency

        // Store interval for cleanup
        this.healthCheckInterval = healthCheckInterval;

        this.logger.info('🏥 Connection health monitoring enabled (check every 10 minutes)');
        this.logger.info('⚡ Rate limiting: 500ms minimum delay between requests');
        this.logger.info('🔄 Auto-retry: Max 5 retries with exponential backoff (up to 30s)');
    }

    async stop() {
        this.logger.info('🛑 Stopping bot...');

        // Clear health check interval
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }

        // Clear all scheduled tasks
        this.scheduledTasks.forEach(task => task.stop());
        this.scheduledTasks.clear();

        // Clear posting locks
        if (this.postingLocks) {
            this.postingLocks.clear();
        }

        // Clear upload timeouts
        if (this.uploadTimeouts) {
            this.uploadTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
            this.uploadTimeouts.clear();
        }

        // Clear pending uploads
        if (this.pendingUploads) {
            this.pendingUploads.clear();
        }

        // Stop bot polling
        await this.bot.stop();

        this.isRunning = false;
        this.logger.info('✅ Bot stopped successfully');
        process.exit(0);
    }

    printScheduleSummary() {
        this.logger.info('='.repeat(60));
        this.logger.info('📅 SCHEDULE SUMMARY');
        this.logger.info('='.repeat(60));

        Object.entries(this.channels).forEach(([channelId, config]) => {
            const status = config.enabled ? '🟢 ACTIVE' : '🔴 INACTIVE';
            this.logger.info(`${status} - ${config.name} (${channelId})`);
            this.logger.info(`    ⏰ Time: ${config.posting_time} (${config.timezone || 'Asia/Jakarta'})`);
        });

        this.logger.info('='.repeat(60));
    }

    async forcePostChannel(channelId) {
        if (!this.channels[channelId]) {
            this.logger.error(`❌ Channel ${channelId} not found`);
            return false;
        }

        const channelConfig = this.channels[channelId];
        this.logger.info(`🚀 Force posting for ${channelConfig.name} (${channelId})`);

        const success = await this.sendMediaToChannel(channelId);

        if (success) {
            channelConfig.last_run = new Date().toISOString();
            await this.saveConfig();
            this.logger.info(`✅ Force posting successful for ${channelConfig.name}`);
        } else {
            this.logger.error(`❌ Force posting failed for ${channelConfig.name}`);
        }

        return success;
    }

    async forcePostAll() {
        this.logger.info('🚀 Force posting for all channels...');

        const results = {};
        for (const channelId of Object.keys(this.channels)) {
            if (this.channels[channelId].enabled) {
                results[channelId] = await this.forcePostChannel(channelId);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        return results;
    }
}

// Main execution
async function main() {
    try {
        const bot = new TelegramMultiChannelBot();
        
        // Initialize bot (load config, create directories, etc)
        await bot.init();
        
        // Start bot (connect to Telegram, setup scheduler, etc)
        await bot.start();

        // Keep the process running
        setInterval(() => {
            // Health check
        }, 30000);

    } catch (error) {
        console.error('💥 Fatal error:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    console.log('='.repeat(60));
    console.log('🤖 TELEGRAM MULTI-CHANNEL BOT');
    console.log('📅 Automated posting with different schedules per channel');
    console.log('='.repeat(60));

    main();
}

module.exports = { TelegramMultiChannelBot };
