# Changelog

## [1.2.0] - 2026-03-06

### 🚀 System Monitor Feature

#### Added
- **System Monitor:** View server status from Telegram
  - Added `/system` command
  - Added "💻 系统监控" button in main menu
  - Real-time display of:
    - System uptime
    - CPU usage (total, user, system, load average)
    - Memory usage (total, used, available, free)
    - Disk usage (total, used, available, percentage)
    - Bot process info (PID, memory)
  - Refresh button to update data
  - Back button to return to menu

#### Benefits
- Monitor server health from Telegram
- No SSH needed to check server status
- Quick troubleshooting
- Track bot resource usage

#### Technical
- Uses Linux commands (free, df, uptime, top)
- Parses and formats system data
- Clean HTML formatting
- Error handling for command failures

---

## [1.1.0] - 2026-03-05

### 🎉 Major Updates

#### Added
- **Cron Job Management:** Schedule automated tasks
  - View all cron jobs
  - Add new cron jobs
  - Delete cron jobs with confirmation
  - Support for complex cron expressions

#### Improved
- **Delete Confirmation:** Added two-step confirmation for deletions
  - Prevents accidental deletions
  - Shows what will be deleted
  - Cancel option available

#### Changed
- Updated README with latest features
- Added update guide
- Improved documentation

---

## [1.0.0] - 2026-03-04

### 🎉 Initial Release

#### Features
- **Provider Management:**
  - Add/edit/delete API providers
  - Support for multiple providers
  - API key management
  - Base URL configuration

- **Model Management:**
  - Add/edit/delete models
  - Model configuration
  - Cost settings
  - Context window settings

- **Configuration:**
  - View current config
  - Edit config directly
  - Restart to apply changes

- **Multi-user Support:**
  - User allowlist
  - Auto-registration for first user
  - Per-user sessions

- **Security:**
  - Zero token usage (direct Telegram API)
  - Secure API key storage
  - User authentication

#### Technical
- Node.js implementation
- Direct HTTPS requests to Telegram
- No external dependencies
- Systemd service support
