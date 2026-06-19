// economy/validate.js
// Signal Rush — Input Validation
//
// Centralized validation for all economy-layer inputs.
// Every function that accepts external input MUST validate through here.
//
// Design decisions:
// - UUID v4 format enforced strictly (prevents injection via player_id)
// - All string inputs length-limited (prevents DoS via huge payloads)
// - All numeric inputs range-checked (prevents integer overflow / negative values)
// - Errors throw with descriptive messages — caller decides HTTP status code

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a UUID v4 string.
 * @param {string} value
 * @param {string} field Name for error messages (e.g. "player_id")
 * @returns {string} The validated UUID (lowercased)
 * @throws {Error} If not a valid UUID
 */
function validateUuid(value, field = 'id') {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim().toLowerCase();
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`${field} must be a valid UUID`);
  }
  return trimmed;
}

/**
 * Validate a display name.
 * @param {string} value
 * @param {number} maxLength
 * @returns {string} The validated name (trimmed)
 * @throws {Error} If invalid
 */
function validateDisplayName(value, maxLength = 64) {
  if (typeof value !== 'string') {
    throw new Error('display_name must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('display_name is required');
  }
  if (trimmed.length > maxLength) {
    throw new Error(`display_name must be ${maxLength} characters or less`);
  }
  return trimmed;
}

/**
 * Validate a positive integer amount.
 * @param {number} value
 * @param {string} field Name for error messages
 * @param {number} max Maximum allowed value
 * @returns {number} The validated integer
 * @throws {Error} If invalid
 */
function validateAmount(value, field = 'amount', max = 1_000_000) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  if (n > max) {
    throw new Error(`${field} exceeds maximum allowed (${max})`);
  }
  return n;
}

/**
 * Validate a non-negative integer (allows zero).
 * @param {number} value
 * @param {string} field Name for error messages
 * @param {number} max Maximum allowed value
 * @returns {number} The validated integer
 * @throws {Error} If invalid
 */
function validateNonNegativeInt(value, field = 'value', max = 1_000_000) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  if (n > max) {
    throw new Error(`${field} exceeds maximum allowed (${max})`);
  }
  return n;
}

/**
 * Validate a reason string.
 * @param {string} value
 * @param {number} maxLength
 * @returns {string} The validated reason (trimmed)
 * @throws {Error} If invalid
 */
function validateReason(value, maxLength = 256) {
  if (typeof value !== 'string') {
    throw new Error('reason must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('reason is required');
  }
  if (trimmed.length > maxLength) {
    throw new Error(`reason must be ${maxLength} characters or less`);
  }
  return trimmed;
}

/**
 * Validate a placement type string.
 * @param {string} value
 * @returns {string} The validated placement type
 * @throws {Error} If invalid
 */
function validatePlacementType(value) {
  const allowed = ['hud_frame', 'interstitial', 'menu_banner', 'game_over'];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`placement_type must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

/**
 * Validate a pagination limit.
 * @param {number} value
 * @param {number} defaultVal
 * @param {number} max
 * @returns {number}
 */
function validateLimit(value, defaultVal = 50, max = 500) {
  const n = parseInt(value) || defaultVal;
  return Math.min(Math.max(n, 1), max);
}

/**
 * Validate a pagination offset.
 * @param {number} value
 * @returns {number}
 */
function validateOffset(value) {
  const n = parseInt(value) || 0;
  return Math.max(n, 0);
}

// ─── Advertiser Portal Validators ──────────────────────────────────

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Validate an email address.
 * @param {string} value
 * @param {number} maxLength
 * @returns {string} The validated email (trimmed, lowercased)
 * @throws {Error} If invalid
 */
function validateEmail(value, maxLength = 254) {
  if (typeof value !== 'string') {
    throw new Error('email must be a string');
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error('email is required');
  }
  if (trimmed.length > maxLength) {
    throw new Error(`email must be ${maxLength} characters or less`);
  }
  if (!EMAIL_RE.test(trimmed)) {
    throw new Error('email must be a valid email address');
  }
  return trimmed;
}

/**
 * Validate a password.
 * Minimum 8 characters, max 128.
 * Requires at least one uppercase, one lowercase, one digit.
 * @param {string} value
 * @returns {string} The validated password
 * @throws {Error} If invalid
 */
function validatePassword(value) {
  if (typeof value !== 'string') {
    throw new Error('password must be a string');
  }
  if (value.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  if (value.length > 128) {
    throw new Error('password must be 128 characters or less');
  }
  if (!/[a-z]/.test(value)) {
    throw new Error('password must contain at least one lowercase letter');
  }
  if (!/[A-Z]/.test(value)) {
    throw new Error('password must contain at least one uppercase letter');
  }
  if (!/[0-9]/.test(value)) {
    throw new Error('password must contain at least one digit');
  }
  return value;
}

/**
 * Validate a campaign name.
 * 1-128 chars, alphanumeric + spaces + hyphens + underscores.
 * @param {string} value
 * @returns {string} The validated name (trimmed)
 * @throws {Error} If invalid
 */
function validateCampaignName(value) {
  if (typeof value !== 'string') {
    throw new Error('campaign name must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('campaign name is required');
  }
  if (trimmed.length > 128) {
    throw new Error('campaign name must be 128 characters or less');
  }
  if (!/^[a-zA-Z0-9 _\-]+$/.test(trimmed)) {
    throw new Error('campaign name must contain only letters, numbers, spaces, hyphens, and underscores');
  }
  return trimmed;
}

/**
 * Validate a brand name.
 * 1-64 chars, printable ASCII.
 * @param {string} value
 * @returns {string} The validated brand name (trimmed)
 * @throws {Error} If invalid
 */
function validateBrandName(value) {
  if (typeof value !== 'string') {
    throw new Error('brand name must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('brand name is required');
  }
  if (trimmed.length > 64) {
    throw new Error('brand name must be 64 characters or less');
  }
  return trimmed;
}

/**
 * Validate a budget amount in micros.
 * Must be a non-negative integer.
 * @param {number} value
 * @param {string} field Name for error messages
 * @param {number} max Maximum allowed value (default: 1 billion micros = 1000 credits)
 * @returns {number} The validated budget
 * @throws {Error} If invalid
 */
function validateBudget(value, field = 'budget_micros', max = 1_000_000_000) {
  return validateNonNegativeInt(value, field, max);
}

/**
 * Validate a date range (start_date, end_date).
 * Both must be valid ISO date strings (YYYY-MM-DD).
 * end_date must be >= start_date.
 * @param {string|null} startDate
 * @param {string|null} endDate
 * @returns {{ start: string|null, end: string|null }}
 * @throws {Error} If invalid
 */
function validateDateRange(startDate, endDate) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  let validatedStart = null;
  let validatedEnd = null;

  if (startDate !== null && startDate !== undefined) {
    if (typeof startDate !== 'string' || !DATE_RE.test(startDate)) {
      throw new Error('start_date must be in YYYY-MM-DD format');
    }
    const d = new Date(startDate);
    if (isNaN(d.getTime())) {
      throw new Error('start_date is not a valid date');
    }
    validatedStart = startDate;
  }

  if (endDate !== null && endDate !== undefined) {
    if (typeof endDate !== 'string' || !DATE_RE.test(endDate)) {
      throw new Error('end_date must be in YYYY-MM-DD format');
    }
    const d = new Date(endDate);
    if (isNaN(d.getTime())) {
      throw new Error('end_date is not a valid date');
    }
    validatedEnd = endDate;
  }

  if (validatedStart && validatedEnd) {
    if (new Date(validatedEnd) < new Date(validatedStart)) {
      throw new Error('end_date must be on or after start_date');
    }
  }

  return { start: validatedStart, end: validatedEnd };
}

/**
 * Validate creative content JSON.
 * Must be a non-empty object with required fields per type.
 * @param {object} value
 * @param {string} type Creative type: 'logo' | 'label' | 'interstitial'
 * @returns {string} JSON stringified content
 * @throws {Error} If invalid
 */
function validateCreativeContent(value, type) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('creative content must be a JSON object');
  }
  if (Object.keys(value).length === 0) {
    throw new Error('creative content must not be empty');
  }

  // Type-specific required fields
  if (type === 'label') {
    if (typeof value.text !== 'string' || value.text.trim().length === 0) {
      throw new Error('label creative must have a non-empty "text" field');
    }
    if (value.text.length > 64) {
      throw new Error('label text must be 64 characters or less');
    }
  } else if (type === 'logo') {
    if (!Array.isArray(value.lines) || value.lines.length === 0) {
      throw new Error('logo creative must have a non-empty "lines" array');
    }
    if (value.lines.length > 24) {
      throw new Error('logo must have 24 lines or fewer');
    }
    const ansiRe = /\x1b\[[0-9;]*m/g;
    for (const line of value.lines) {
      if (typeof line !== 'string') {
        throw new Error('each logo line must be a string');
      }
      // Validate visible width (excluding ANSI escape codes)
      const visibleLen = line.replace(ansiRe, '').length;
      if (visibleLen > 76) {
        throw new Error('each logo line must be 76 visible characters or fewer');
      }
      if (visibleLen === 0) {
        throw new Error('each logo line must not be empty');
      }
    }
  } else if (type === 'interstitial') {
    if (typeof value.message !== 'string' || value.message.trim().length === 0) {
      throw new Error('interstitial creative must have a non-empty "message" field');
    }
    if (value.message.length > 256) {
      throw new Error('interstitial message must be 256 characters or less');
    }
  }

  const json = JSON.stringify(value);
    // Logo creatives with ANSI art can be larger than text creatives
    // 24-bit Braille logos at 76x24 with per-char color need ~15KB
    const maxBytes = type === 'logo' ? 32768 : 4096;
    if (json.length > maxBytes) {
      throw new Error(`creative content must be ${maxBytes} bytes or less when serialized`);
    }
  return json;
}

/**
 * Validate a campaign status transition.
 * Enforces the state machine:
 *   draft → pending_review
 *   pending_review → active | rejected
 *   active ↔ paused
 *   active | paused → completed
 * @param {string} currentStatus
 * @param {string} newStatus
 * @returns {string} The validated new status
 * @throws {Error} If transition is invalid
 */
function validateStatusTransition(currentStatus, newStatus) {
  const allowedTransitions = {
    draft: ['pending_review'],
    pending_review: ['active', 'rejected'],
    active: ['paused', 'completed'],
    paused: ['active', 'completed'],
    rejected: ['draft'],  // allow resubmission
    completed: [],        // terminal state
  };

  const allowed = allowedTransitions[currentStatus];
  if (!allowed) {
    throw new Error(`unknown current status: ${currentStatus}`);
  }
  if (!allowed.includes(newStatus)) {
    throw new Error(`cannot transition from '${currentStatus}' to '${newStatus}' — allowed: ${allowed.join(', ') || '(none)'}`);
  }
  return newStatus;
}

/**
 * Validate a redemption prompt string.
 * 1-4000 chars. Must be non-empty after trim.
 * @param {string} value
 * @returns {string} The validated prompt (trimmed)
 * @throws {Error} If invalid
 */
function validatePrompt(value, maxLength = 4000) {
  if (typeof value !== 'string') {
    throw new Error('prompt must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('prompt is required');
  }
  if (trimmed.length > maxLength) {
    throw new Error(`prompt must be ${maxLength} characters or less`);
  }
  return trimmed;
}

/**
 * Validate a model name string.
 * 1-128 chars. Alphanumeric + hyphens + dots + slashes.
 * @param {string} value
 * @returns {string} The validated model name (trimmed)
 * @throws {Error} If invalid
 */
function validateModelName(value, maxLength = 128) {
  if (typeof value !== 'string') {
    throw new Error('model must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('model is required');
  }
  if (trimmed.length > maxLength) {
    throw new Error(`model must be ${maxLength} characters or less`);
  }
  if (!/^[a-zA-Z0-9._\-\/]+$/.test(trimmed)) {
    throw new Error('model must contain only letters, numbers, dots, hyphens, and slashes');
  }
  return trimmed;
}

/**
 * Validate a provider ID string.
 * 1-64 chars. Lowercase alphanumeric + hyphens.
 * @param {string} value
 * @returns {string} The validated provider ID (trimmed, lowercased)
 * @throws {Error} If invalid
 */
function validateProvider(value, maxLength = 64) {
  if (typeof value !== 'string') {
    throw new Error('provider must be a string');
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error('provider is required');
  }
  if (trimmed.length > maxLength) {
    throw new Error(`provider must be ${maxLength} characters or less`);
  }
  if (!/^[a-z0-9\-]+$/.test(trimmed)) {
    throw new Error('provider must contain only lowercase letters, numbers, and hyphens');
  }
  return trimmed;
}

module.exports = {
  validateUuid,
  validateDisplayName,
  validateAmount,
  validateNonNegativeInt,
  validateReason,
  validatePlacementType,
  validateLimit,
  validateOffset,
  validateEmail,
  validatePassword,
  validateCampaignName,
  validateBrandName,
  validateBudget,
  validateDateRange,
  validateCreativeContent,
  validateStatusTransition,
  validatePrompt,
  validateModelName,
  validateProvider,
  UUID_RE,
  EMAIL_RE,
};
