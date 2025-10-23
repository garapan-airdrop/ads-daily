# Telegram Multi-Channel Bot

## Overview

This is an automated Telegram bot designed to manage scheduled promotional posts across multiple Telegram channels. The bot posts marketing content (images with text and buttons) to different channels at configured times, with features like automatic deletion of old messages, duplicate prevention, and support for multiple inline buttons per message.

The bot is built for promotional/marketing use cases where consistent daily content needs to be posted to numerous Telegram channels without manual intervention.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Core Components

**1. Scheduling System**
- Uses `node-cron` for time-based task execution
- Each channel has an independent schedule defined by `posting_time` and `timezone`
- Tasks are scheduled dynamically based on channel configuration
- Posting locks prevent duplicate executions during the same time window

**2. State Management**
- Channel configurations stored in `channels_config.json`
- Per-channel posting history tracked in separate JSON files under `/history` directory
- History includes: previously posted media files, last posting timestamp, and message IDs
- Configuration updates are persisted back to disk after each posting operation

**3. Message Posting Flow**
- Bot selects random image from channel-specific folder (`image_folder` path)
- Constructs message with promotional text (`promo_text`)
- Attaches inline keyboard with action buttons (registration, support links, etc.)
- Posts to channel and stores message ID for future deletion
- Tracks posted media to avoid showing the same image consecutively

**4. Auto-Deletion Logic**
- Before posting new content, bot deletes all previous messages using stored message IDs
- Ensures only one active promotional post per channel at any time
- Prevents message duplication even if bot restarts on the same day

**5. Button Configuration**
- Supports legacy single-button format: `button_text` + `button_url`
- Supports modern multi-button format: array of `buttons` with `text` and `url`
- Buttons are rendered as Telegram inline keyboard with URL actions

### Technology Stack

**Runtime & Language**
- Node.js with JavaScript
- CommonJS module system (`require` syntax)

**Key Dependencies**
- `grammy`: Modern Telegram Bot API framework (wrapper around Bot API)
- `node-cron`: Cron-based job scheduler for timed executions
- `winston`: Structured logging to console and daily log files
- `dotenv`: Environment variable management for bot token
- `node-fetch`: HTTP client for API calls (polyfill for older Node versions)

**File System Operations**
- Reads/writes JSON configuration and history files
- Randomly selects images from channel-specific asset directories
- Uses promises-based `fs` API for async file operations

### Configuration Schema

**Channel Object Structure:**
```javascript
{
  "id": "@channelname",           // Telegram channel username
  "name": "Display Name",         // Human-readable channel name
  "posting_time": "HH:MM",        // Daily posting time (24-hour format)
  "timezone": "Area/City",        // IANA timezone identifier
  "image_folder": "assets/path",  // Directory containing promotional images
  "promo_text": "Message text",   // Text content for the post
  "enabled": true/false,          // Whether channel is active
  "buttons": [...],               // Array of inline buttons
  "last_run": "ISO timestamp"     // Last successful posting time
}
```

**History Object Structure:**
```javascript
{
  "posted_media": ["file1.jpg", "file2.png"],  // Previously posted images
  "last_posted": "ISO timestamp",               // Last posting timestamp
  "message_ids": [123, 456]                     // Telegram message IDs for deletion
}
```

### Error Handling & Logging

- Global error handler catches unhandled exceptions and promise rejections
- Winston logger writes to both console and date-stamped log files
- Logs include timestamp, level, and descriptive messages
- Lock mechanisms prevent concurrent posting to same channel

### Design Patterns

**Singleton Pattern**: Single bot instance manages all channels

**Configuration-Driven**: Channel behavior entirely defined by JSON config, no code changes needed to add/modify channels

**Idempotent Operations**: Duplicate prevention ensures posting same content multiple times has same effect as posting once

**State Persistence**: All state changes (last run time, posted media, message IDs) are immediately written to disk

## External Dependencies

### Third-Party Services

**Telegram Bot API**
- Primary integration for all bot functionality
- Requires `TELEGRAM_BOT_TOKEN` environment variable
- Uses grammY library as API wrapper
- Bot must have admin permissions in target channels to post and delete messages

### File System Dependencies

**Configuration Files:**
- `channels_config.json`: Main channel configuration
- `.env`: Environment variables (bot token)

**Runtime Directories:**
- `history/`: Per-channel posting history JSON files
- `logs/`: Daily log files
- `assets/{channel}/`: Channel-specific image directories

**Image Assets:**
- Promotional images stored per-channel in configurable directories
- Supported formats: JPG, PNG (any format supported by Telegram)
- Bot randomly selects images and tracks usage to avoid repetition

### External APIs

**Telegram Bot API Endpoints Used:**
- Send photo with caption and inline keyboard
- Delete messages by message ID
- Bot must be administrator in target channels

### Node.js Requirements

- Node.js runtime (version with native fetch support recommended, or uses node-fetch polyfill)
- File system access for reading/writing JSON and image files
- Network access to Telegram API servers