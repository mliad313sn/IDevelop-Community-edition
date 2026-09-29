const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Create Winston logger
const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: require('../config/product').slug },
    transports: [
        // Size-capped + rotated so logs/ can't grow unbounded on a long-running host.
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            maxsize: Number(process.env.LOG_MAX_BYTES || 10 * 1024 * 1024),
            maxFiles: Number(process.env.LOG_MAX_FILES || 5),
            tailable: true,
        }),
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            maxsize: Number(process.env.LOG_MAX_BYTES || 10 * 1024 * 1024),
            maxFiles: Number(process.env.LOG_MAX_FILES || 5),
            tailable: true,
        }),
    ],
});

// Add console transport in development
if (process.env.NODE_ENV !== 'production') {
    logger.add(
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf((info) => {
                    // Handle both string messages and object messages
                    let message = info.message || '';

                    // If message is an object, stringify it
                    if (typeof message === 'object' && message !== null) {
                        message = JSON.stringify(message, null, 2);
                    }

                    // Build the log line
                    let logLine = `${info.timestamp} [${info.level}]: ${message}`;

                    // Add metadata if present (excluding defaultMeta)
                    const meta = { ...info };
                    delete meta.level;
                    delete meta.message;
                    delete meta.timestamp;
                    delete meta.service;
                    delete meta.splat;

                    if (Object.keys(meta).length > 0) {
                        const metaStr = JSON.stringify(meta, null, 2);
                        logLine += '\n' + metaStr;
                    }

                    return logLine;
                })
            ),
        })
    );
}

// Query-string keys whose VALUES are secrets and must never hit the log files.
// e.g. the password-reset link is GET /reset-password?token=<raw>, and SSO
// callbacks carry ?code=/?access_token=. Logging req.originalUrl verbatim would
// persist a live, single-use token to combined.log (replayable → takeover).
const SENSITIVE_QS =
    /^(token|code|access_token|refresh_token|id_token|state|api_?key|password|secret|assertion)$/i;

function safeUrl(req) {
    const keys = req.query ? Object.keys(req.query) : [];
    if (!keys.length) return req.path;
    const qs = keys
        .map(
            (k) =>
                `${k}=${SENSITIVE_QS.test(k) ? 'REDACTED' : encodeURIComponent(String(req.query[k]))}`
        )
        .join('&');
    return `${req.path}?${qs}`;
}

// Express middleware for request logging
const requestLogger = (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        // Skip logging for static assets and favicon
        if (
            req.path.startsWith('/css/') ||
            req.path.startsWith('/js/') ||
            req.path.startsWith('/images/') ||
            req.path === '/favicon.ico'
        ) {
            return;
        }

        const duration = Date.now() - start;
        logger.info(`${req.method} ${safeUrl(req)} - ${res.statusCode} - ${duration}ms`, {
            requestId: req.id || null,
        });
    });

    next();
};

module.exports = {
    logger,
    requestLogger,
    safeUrl, // exported so the error handler can redact token/code query params too
};
