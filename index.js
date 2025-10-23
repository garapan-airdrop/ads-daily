
const fs = require('fs').promises;
const path = require('path');
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const cron = require('node-cron');
const winston = require('winston');
require('dotenv').config();

// Force IPv4 DNS resolution globally
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

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
        // Force IPv4 environment configuration
        process.env.NODE_OPTIONS = '--dns-result-order=ipv4first';
        
        // Create bot with custom configuration for better network handling
        this.bot = new Bot(process.env.TELEGRAM_BOT_TOKEN, {
            client: {
                timeoutSeconds: 60, // Increase timeout to 60 seconds
                canUseWebhookReply: false,
                baseFetchConfig: {
                    compress: true,
                    agent: undefined // Let Node.js handle agent with IPv4 preference
                }
            }
        });
        
        this.channels = {};
        this.globalSettings = {};
        this.postingRules = {};
        this.isRunning = false;
        this.scheduledTasks = new Map();
        this.postingLocks = new Set();
        this.pendingUploads = new Map();
        this.uploadTimeouts = new Map();

        this.setupLogger();
        this.loadConfig();
        this.setupErrorHandler();
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

            this.channels = {};
            config.channels?.forEach(channel => {
                if (channel.enabled !== false) {
                    this.channels[channel.id] = channel;
                }
            });

            this.globalSettings = config.global_settings || {};
            this.postingRules = config.posting_rules || {};

            // Auto-generate posting times if not set
            await this.autoGeneratePostingTimes();

            this.logger.info(`📋 Config loaded for ${Object.keys(this.channels).length} active channels`);
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
            const config = {
                channels: Object.values(this.channels),
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
                await this.bot.api.getChat(channelId);
                this.logger.info(`✅ Channel access valid: ${channel.name} (${channelId})`);
                // Add delay to prevent rate limiting (500ms between checks)
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                this.logger.error(`❌ Cannot access channel ${channelId}: ${error.message}`);
            }
        }
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
                    await this.bot.api.deleteMessage(channelId, messageId);
                    this.logger.info(`✅ Deleted message ${messageId} from ${channelId}`);
                } catch (error) {
                    this.logger.warn(`⚠️ Could not delete message ${messageId}: ${error.message}`);
                }
            }

            // Clear message_ids after deletion
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

        try {
            // Delete old messages before sending new one
            await this.deleteOldMessages(channelId);

            const { mediaPath, mediaFilename, isVideo } = await this.getNextMediaForChannel(channelId);

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

            // Send media based on type
            let sentMessage;
            if (isVideo) {
                sentMessage = await this.bot.api.sendVideo(channelId, new InputFile(mediaPath), {
                    caption: channelConfig.promo_text,
                    parse_mode: this.postingRules.parse_mode || 'Markdown',
                    reply_markup: keyboard
                });
            } else {
                sentMessage = await this.bot.api.sendPhoto(channelId, new InputFile(mediaPath), {
                    caption: channelConfig.promo_text,
                    parse_mode: this.postingRules.parse_mode || 'Markdown',
                    reply_markup: keyboard
                });
            }

            // Save message_id for future deletion
            const history = await this.loadChannelHistory(channelId);
            const postedMedia = history.posted_media || [];

            if (!postedMedia.includes(mediaFilename)) {
                postedMedia.push(mediaFilename);
                history.posted_media = postedMedia;
            }

            // Store the new message_id
            history.message_ids = [sentMessage.message_id];
            history.last_posted = new Date().toISOString();
            await this.saveChannelHistory(channelId, history);

            this.logger.info(`📤 ${isVideo ? 'Video' : 'Image'} sent successfully to ${channelConfig.name}: ${mediaFilename} (message_id: ${sentMessage.message_id})`);
            return true;

        } catch (error) {
            this.logger.error(`❌ Error sending media to ${channelId}: ${error.message}`);

            // Mark problematic files as posted to avoid retry loop
            if (error.message.includes('Request Entity Too Large') || 
                error.message.includes('wrong remote file identifier') ||
                error.message.includes('Bad Request')) {
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

    shouldPost(channelId, currentTime, schedule) {
        try {
            // Validate posting_time format
            if (!schedule.posting_time || !schedule.posting_time.match(/^\d{1,2}:\d{2}$/)) {
                this.logger.warn(`⚠️ Invalid posting_time format for ${channelId}: ${schedule.posting_time}`);
                return false;
            }

            const [hour, minute] = schedule.posting_time.split(':').map(Number);

            // Validate hour and minute ranges
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                this.logger.warn(`⚠️ Invalid time values for ${channelId}: ${hour}:${minute}`);
                return false;
            }

            const postingTime = new Date(currentTime);
            postingTime.setHours(hour, minute, 0, 0);

            // Check if current time is past posting time today
            if (currentTime < postingTime) {
                return false;
            }

            // Check if already posted today (with timezone consideration)
            const today = currentTime.toDateString();
            const lastRun = schedule.last_run ? new Date(schedule.last_run).toDateString() : null;

            const shouldPost = lastRun !== today;

            if (shouldPost) {
                this.logger.debug(`📅 Should post to ${channelId}: current=${currentTime.toLocaleTimeString()}, scheduled=${schedule.posting_time}, lastRun=${lastRun}`);
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
                    last_run: channelConfig.last_run || null
                };

                if (this.shouldPost(channelId, currentTime, schedule)) {
                    // Lock this channel to prevent duplicate posting
                    this.postingLocks.add(channelId);

                    this.logger.info(`⏰ Posting time for ${channelConfig.name} (${channelId})`);

                    try {
                        const success = await this.sendMediaToChannel(channelId);

                        if (success) {
                            channelConfig.last_run = currentTime.toISOString();
                            await this.saveConfig(); // Save immediately to prevent duplicates
                            this.logger.info(`✅ Posting successful for ${channelConfig.name}`);
                        } else {
                            this.logger.error(`❌ Posting failed for ${channelConfig.name}`);
                        }
                    } catch (postError) {
                        this.logger.error(`❌ Error posting to ${channelId}: ${postError.message}`);
                    } finally {
                        // Always unlock this channel
                        this.postingLocks.delete(channelId);
                    }

                    // Delay between channels to prevent rate limiting
                    await new Promise(resolve => setTimeout(resolve, 3000));
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
                if (text.startsWith('!add ')) {
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
                if (data.startsWith('channels_page_')) {
                    const page = parseInt(data.replace('channels_page_', ''));
                    await ctx.answerCallbackQuery();
                    await ctx.deleteMessage();
                    await this.sendChannelListPaginated(ctx, page);
                } else if (data.startsWith('folders_page_')) {
                    const page = parseInt(data.replace('folders_page_', ''));
                    await ctx.answerCallbackQuery();
                    await ctx.deleteMessage();
                    await this.sendFolderListPaginated(ctx, page);
                } else if (data === 'noop') {
                    await ctx.answerCallbackQuery();
                }
            } catch (error) {
                this.logger.error(`❌ Error handling callback query: ${error.message}`);
                await ctx.answerCallbackQuery('❌ Error processing request');
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
            // Log network configuration
            this.logger.info('🌐 Network Configuration: IPv4-ONLY mode enabled');
            this.logger.info(`🌐 DNS Resolution Order: ${dns.getDefaultResultOrder()}`);

            // Validate bot token with retry mechanism
            let authenticated = false;
            let retryCount = 0;
            const maxRetries = 10;
            
            while (!authenticated && retryCount < maxRetries) {
                try {
                    this.logger.info(`🔄 Attempting to connect to Telegram API... (Attempt ${retryCount + 1}/${maxRetries})`);
                    
                    // Test DNS resolution first
                    if (retryCount === 0) {
                        try {
                            const dns = require('dns').promises;
                            const addresses = await dns.resolve4('api.telegram.org');
                            this.logger.info(`✅ DNS Resolution successful: ${addresses[0]}`);
                        } catch (dnsError) {
                            this.logger.warn(`⚠️ DNS Resolution warning: ${dnsError.message}`);
                        }
                    }
                    
                    const me = await this.bot.api.getMe();
                    this.logger.info(`🤖 Bot authenticated: ${me.first_name} (@${me.username})`);
                    authenticated = true;
                } catch (error) {
                    retryCount++;
                    this.logger.warn(`⚠️ Connection attempt ${retryCount} failed: ${error.message}`);
                    
                    if (retryCount < maxRetries) {
                        // Progressive backoff: 2s, 4s, 8s, 15s, 30s, then 60s
                        const delays = [2000, 4000, 8000, 15000, 30000, 60000, 60000, 60000, 60000, 60000];
                        const waitTime = delays[Math.min(retryCount - 1, delays.length - 1)];
                        this.logger.info(`⏳ Retrying in ${waitTime/1000} seconds...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else {
                        this.logger.error(`❌ Bot token validation failed after ${maxRetries} attempts`);
                        this.logger.error(`💡 Troubleshooting:`);
                        this.logger.error(`   1. Check internet connectivity: ping 8.8.8.8`);
                        this.logger.error(`   2. Check DNS: nslookup api.telegram.org`);
                        this.logger.error(`   3. Verify bot token in .env file`);
                        this.logger.error(`   4. Check Telegram API status: https://status.telegram.org`);
                        throw new Error('Unable to connect to Telegram API after multiple attempts');
                    }
                }
            }

            await this.createDirectories();
            await this.setupBotCommands();

            this.logger.info('🚀 Starting Telegram Multi-Channel Bot...');
            this.logger.info(`📋 Config loaded for ${Object.keys(this.channels).filter(id => this.channels[id].enabled).length} active channels`);

            await this.validateChannelAccess();

            this.setupScheduler();

            // Start schedulers
            this.scheduledTasks.get('main').start();
            this.scheduledTasks.get('cleanup').start();
            this.scheduledTasks.get('memory-cleanup').start();

            // Start bot polling for commands
            this.bot.start();
            this.isRunning = true;

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

    async stop() {
        this.logger.info('🛑 Stopping bot...');

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
