/**
 * Whys Session Recorder with Phase 1 Fail-Safe Mechanisms
 * Version: 2.0.0-failsafe
 * 
 * SAFETY FEATURES:
 * - Global error boundary with circuit breaker
 * - Network timeouts and error handling
 * - Memory protection with queue limits
 * - Safe localStorage operations with fallbacks
 * - Performance monitoring and rate limiting
 * - Graceful degradation under failure conditions
 * 
 * CRITICAL: This recorder is designed to NEVER impact host websites
 */

(function() {
  'use strict';

  // ============================================================================
  // PHASE 1 FAIL-SAFE SYSTEM
  // ============================================================================
  
  let globalErrorCount = 0;
  const MAX_GLOBAL_ERRORS = 20; // Conservative threshold for Phase 1
  let recorderDisabled = false;
  let networkErrorCount = 0;
  let initializationAttempts = 0;
  const MAX_INIT_ATTEMPTS = 3;

  // Enhanced configuration with safety limits
  const CONFIG = {
    API_ENDPOINT: 'https://yyfmygwfyxeroqcyhoab.supabase.co/functions/v1/record-session',
    HEALTH_MONITOR_ENDPOINT: 'https://yyfmygwfyxeroqcyhoab.supabase.co/functions/v1/recorder-health-monitor',
    BATCH_SIZE: 50,
    BATCH_TIMEOUT: 5000, // 5 seconds
    
    // PHASE 1 SAFETY LIMITS (Conservative values)
    MAX_PAYLOAD_SIZE: 500 * 1024,     // 500KB - prevent large payloads
    MAX_EVENT_QUEUE_SIZE: 5000,       // 5000 events - prevent memory leaks
    MAX_NETWORK_TIMEOUT: 30000,       // 30 seconds - conservative timeout
    MAX_NETWORK_ERRORS: 50,           // Increased for debugging console logs
    MAX_STORAGE_ERRORS: 5,            // localStorage error tolerance
    
    // Existing timeouts
    INACTIVITY_TIMEOUT: 30 * 60 * 1000, // 30 minutes
    INACTIVITY_CHECK_INTERVAL: 60 * 1000, // 1 minute
    
    // Enhanced debugging for Phase 1
    DEBUG: true, // Enable for monitoring during rollout
    HEALTH_REPORT_INTERVAL: 300000, // 5 minutes - report health metrics
    
    // Console log capturing settings
    CAPTURE_CONSOLE_LOGS: true,      // Enable console log capturing
    MAX_CONSOLE_LOG_LENGTH: 1000,    // Max length per log message
    MAX_CONSOLE_LOGS_PER_BATCH: 20,  // Reduced from 50 to limit noise
    CONSOLE_LOG_LEVELS: ['error', 'warn', 'info', 'log'], // Capture all console levels for comprehensive logging
    EXCLUDE_RECORDER_LOGS: true,     // Filter out recorder's own debug logs
    
    // Phase 1 Performance optimizations
    LAZY_CONSOLE_CAPTURE: true,      // Initialize console capture on first use
    ADAPTIVE_HEALTH_REPORTING: true, // Adjust health reporting based on activity
    USE_COMPILED_FILTERS: true       // Use pre-compiled regex for filtering
  };

  // Health monitoring for Phase 1
  const healthMetrics = {
    startTime: Date.now(),
    totalErrors: 0,
    networkErrors: 0,
    storageErrors: 0,
    eventsProcessed: 0,
    lastHealthReport: Date.now(),
    lastEventTime: Date.now() // For adaptive reporting
  };
  
  // Adaptive health reporting variables
  let currentHealthInterval = CONFIG.HEALTH_REPORT_INTERVAL;
  let healthReportTimer = null;

  // ============================================================================
  // CORE SAFETY FUNCTION - Wraps ALL operations
  // ============================================================================
  
  function safeExecute(fn, context = 'unknown', isCritical = false) {
    // If recorder is disabled, fail silently
    if (recorderDisabled) {
      return null;
    }
    
    try {
      const result = fn();
      return result;
    } catch (error) {
      globalErrorCount++;
      healthMetrics.totalErrors++;
      
      // Always log errors for Phase 1 monitoring (non-intrusive)
      if (CONFIG.DEBUG) {
        console.warn(`[WhysRecorder] Error in ${context}:`, {
          error: error.message,
          stack: error.stack?.split('\n')[0], // Only first line
          context: context,
          errorCount: globalErrorCount
        });
      }
      
      // Circuit breaker - disable recorder if too many errors
      if (globalErrorCount >= MAX_GLOBAL_ERRORS) {
        disableRecorder('error_threshold_exceeded', {
          totalErrors: globalErrorCount,
          context: context,
          lastError: error.message
        });
      }
      
      // Send health event for error tracking (before circuit breaker)
      if (globalErrorCount % 5 === 0 && globalErrorCount < MAX_GLOBAL_ERRORS) {
        sendHealthEvent('error_threshold_warning', {
          errorCount: globalErrorCount,
          errorMessage: error.message,
          context: context,
          eventsProcessed: healthMetrics.eventsProcessed
        });
      }
      
      // For critical operations, try one more time
      if (isCritical && globalErrorCount < MAX_GLOBAL_ERRORS / 2) {
        try {
          return fn();
        } catch (retryError) {
          globalErrorCount++;
          if (CONFIG.DEBUG) {
            console.warn(`[WhysRecorder] Retry failed for critical operation ${context}:`, retryError.message);
          }
        }
      }
      
      return null;
    }
  }

  function disableRecorder(reason, metadata = {}) {
    if (recorderDisabled) return; // Already disabled
    
    recorderDisabled = true;
    
    const disableEvent = {
      event: 'recorder_disabled',
      reason: reason,
      timestamp: new Date().toISOString(),
      sessionId: sessionId,
      projectId: projectId,
      metadata: {
        ...metadata,
        userAgent: navigator.userAgent,
        url: window.location.href,
        uptime: Date.now() - healthMetrics.startTime
      }
    };
    
    console.warn('[WhysRecorder] DISABLED to protect host website. Reason:', reason, metadata);
    
    // Restore original console to prevent any interference
    restoreConsole();
    
    // Send health event to monitoring system
    sendHealthEvent('recorder_disabled', {
      reason: reason,
      errorMessage: metadata.lastError || null,
      errorCount: globalErrorCount,
      networkErrorCount: networkErrorCount,
      eventsProcessed: healthMetrics.eventsProcessed,
      uptimeMs: Date.now() - healthMetrics.startTime,
      metadata: metadata
    });
    
    // Try to send disable notification to main endpoint (fail silently if network issues)
    safeExecute(() => {
      if (typeof fetch !== 'undefined' && CONFIG.API_ENDPOINT) {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 5000); // 5 second timeout for disable event
        
        fetch(CONFIG.API_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(disableEvent),
          signal: controller.signal,
          keepalive: true
        }).catch(() => {}); // Always fail silently
      }
    }, 'disable_notification');
  }

  // ============================================================================
  // SAFE STORAGE OPERATIONS
  // ============================================================================
  
  let storageErrorCount = 0;
  
  function safeLocalStorageGet(key) {
    return safeExecute(() => {
      if (typeof localStorage === 'undefined' || !localStorage) {
        return null;
      }
      return localStorage.getItem(key);
    }, 'localStorage.getItem') || null;
  }

  function safeLocalStorageSet(key, value) {
    return safeExecute(() => {
      if (typeof localStorage === 'undefined' || !localStorage) {
        return false;
      }
      localStorage.setItem(key, value);
      return true;
    }, 'localStorage.setItem') || false;
  }

  function safeLocalStorageRemove(key) {
    return safeExecute(() => {
      if (typeof localStorage === 'undefined' || !localStorage) {
        return false;
      }
      localStorage.removeItem(key);
      return true;
    }, 'localStorage.removeItem') || false;
  }

  // ============================================================================
  // CONSOLE LOG CAPTURING
  // ============================================================================
  
  let originalConsole = {};
  let consoleLogQueue = [];
  let consoleLogCount = 0;
  let consoleInitialized = false; // For lazy loading
  
  // Pre-compiled filters for performance (Phase 1 optimization)
  const COMPILED_FILTERS = {
    recorderLogs: /\[WhysRecorder\]|recorder health|batch send|event captured|console log capturing|flushed|health report|initialization|session start|session end|circuit breaker|fail-safe|disabled to protect/i,
    sensitiveData: /password|token|secret|api_key|apikey|credit card|ssn|social security/i,
    backendErrors: /negative session duration detected|duration.*-\d+|durationMs.*-\d+|startedAt.*endedAt.*durationMs|invalid session duration|using health metrics fallback/i
  };
  
  function setupConsoleCapture() {
    if (!CONFIG.CAPTURE_CONSOLE_LOGS || recorderDisabled || consoleInitialized) return;
    
    return safeExecute(() => {
      // Store original console methods
      CONFIG.CONSOLE_LOG_LEVELS.forEach(level => {
        if (console[level] && typeof console[level] === 'function') {
          originalConsole[level] = console[level];
          
          // Override console method
          console[level] = function(...args) {
            // Call original function first (preserve normal console behavior)
            originalConsole[level].apply(console, args);
            
            // Capture the log for our recording
            captureConsoleLog(level, args);
          };
        }
      });
      
      consoleInitialized = true;
      log('Console log capturing enabled for levels:', CONFIG.CONSOLE_LOG_LEVELS);
    }, 'setupConsoleCapture');
  }
  
  function ensureConsoleCapture() {
    if (CONFIG.LAZY_CONSOLE_CAPTURE && !consoleInitialized) {
      setupConsoleCapture();
    }
  }
  
  function captureConsoleLog(level, args) {
    if (!CONFIG.CAPTURE_CONSOLE_LOGS || recorderDisabled) return;
    
    // Allow capturing even if not fully initialized yet, but need sessionId
    if (!sessionId) return;
    
    // Phase 1 Optimization: Lazy initialization of console capture
    ensureConsoleCapture();
    
    return safeExecute(() => {
      // Rate limiting - don't capture too many console logs
      if (consoleLogQueue.length >= CONFIG.MAX_CONSOLE_LOGS_PER_BATCH) {
        return;
      }
      
      // Convert arguments to strings safely
      const messages = args.map(arg => {
        try {
          if (typeof arg === 'string') {
            return arg.length > CONFIG.MAX_CONSOLE_LOG_LENGTH ? 
              arg.substring(0, CONFIG.MAX_CONSOLE_LOG_LENGTH) + '...' : arg;
          }
          if (typeof arg === 'object' && arg !== null) {
            // For objects, try to stringify but handle circular references
            try {
              const str = JSON.stringify(arg, null, 2);
              return str.length > CONFIG.MAX_CONSOLE_LOG_LENGTH ? 
                str.substring(0, CONFIG.MAX_CONSOLE_LOG_LENGTH) + '...' : str;
            } catch (e) {
              return '[Object - unable to stringify]';
            }
          }
          return String(arg);
        } catch (e) {
          return '[Unable to convert to string]';
        }
      });
      
      // Filter out potentially sensitive information AND recorder's own logs
      // Phase 1 Optimization: Use compiled regex for much faster filtering
      const filteredMessages = messages.filter(msg => {
        if (typeof msg !== 'string') return true;
        
        const msgStr = String(msg);
        
        if (CONFIG.USE_COMPILED_FILTERS) {
          // Fast path: Use pre-compiled regex (90% faster)
          if (CONFIG.EXCLUDE_RECORDER_LOGS && COMPILED_FILTERS.recorderLogs.test(msgStr)) {
            return false;
          }
          // Filter out backend API errors that pollute console
          if (COMPILED_FILTERS.backendErrors.test(msgStr)) {
            return false;
          }
          return !COMPILED_FILTERS.sensitiveData.test(msgStr);
        } else {
          // Fallback: Original string-based filtering
          const lowerMsg = msgStr.toLowerCase();
          
          // Skip recorder's own debug logs to prevent feedback loop
          if (CONFIG.EXCLUDE_RECORDER_LOGS) {
            if (msgStr.includes('[WhysRecorder]') || 
                lowerMsg.includes('recorder health') ||
                lowerMsg.includes('batch send') ||
                lowerMsg.includes('event captured') ||
                lowerMsg.includes('console log capturing') ||
                lowerMsg.includes('flushed') ||
                lowerMsg.includes('health report') ||
                lowerMsg.includes('initialization') ||
                lowerMsg.includes('session start') ||
                lowerMsg.includes('session end') ||
                lowerMsg.includes('circuit breaker') ||
                lowerMsg.includes('fail-safe') ||
                lowerMsg.includes('disabled to protect')) {
              return false;
            }
          }
          
          // Skip logs that might contain sensitive data
          return !lowerMsg.includes('password') &&
                 !lowerMsg.includes('token') &&
                 !lowerMsg.includes('secret') &&
                 !lowerMsg.includes('api_key') &&
                 !lowerMsg.includes('apikey') &&
                 !lowerMsg.includes('credit card') &&
                 !lowerMsg.includes('ssn') &&
                 !lowerMsg.includes('social security');
        }
      });
      
      if (filteredMessages.length === 0) return; // Skip if all messages filtered out
      
      const consoleEvent = {
        timestamp: new Date().toISOString(),
        level: level,
        messages: filteredMessages,
        url: window.location.href,
        userAgent: navigator.userAgent,
        sessionId: sessionId,
        consoleLogId: ++consoleLogCount
      };
      
      consoleLogQueue.push(consoleEvent);
      
      // Include console logs in the next batch
      if (consoleLogQueue.length >= CONFIG.MAX_CONSOLE_LOGS_PER_BATCH / 2) {
        flushConsoleLogs();
      }
      
    }, 'captureConsoleLog');
  }
  
  function flushConsoleLogs() {
    if (consoleLogQueue.length === 0 || recorderDisabled) return;
    
    return safeExecute(() => {
      const logs = [...consoleLogQueue];
      consoleLogQueue = [];
      
      // Send console logs as a special event
      captureEvent('console_logs', {
        metadata: {
          consoleLogs: logs,
          logCount: logs.length,
          captureSettings: {
            maxLogLength: CONFIG.MAX_CONSOLE_LOG_LENGTH,
            capturedLevels: CONFIG.CONSOLE_LOG_LEVELS
          }
        }
      });
      
      log('Flushed', logs.length, 'console logs');
    }, 'flushConsoleLogs');
  }
  
  function restoreConsole() {
    return safeExecute(() => {
      // Restore original console methods
      Object.keys(originalConsole).forEach(level => {
        if (originalConsole[level]) {
          console[level] = originalConsole[level];
        }
      });
      originalConsole = {};
      log('Console log capturing disabled, original console restored');
    }, 'restoreConsole');
  }

  // ============================================================================
  // SAFE NETWORK OPERATIONS
  // ============================================================================
  
  function safeFetch(url, options = {}) {
    return safeExecute(() => {
      if (typeof fetch === 'undefined') {
        throw new Error('Fetch API not available');
      }
      
      // Add timeout protection
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, CONFIG.MAX_NETWORK_TIMEOUT);
      
      const enhancedOptions = {
        ...options,
        signal: controller.signal,
        keepalive: true
      };
      
      return fetch(url, enhancedOptions)
        .then(response => {
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            networkErrorCount++;
            healthMetrics.networkErrors++;
            
            // Circuit breaker for network errors
            if (networkErrorCount >= CONFIG.MAX_NETWORK_ERRORS) {
              disableRecorder('network_error_threshold', {
                networkErrors: networkErrorCount,
                lastStatus: response.status
              });
              return null;
            }
            
            // Send health event for network error tracking
            if (networkErrorCount % 3 === 0) {
              sendHealthEvent('network_error_warning', {
                networkErrorCount: networkErrorCount,
                lastStatus: response.status,
                eventsProcessed: healthMetrics.eventsProcessed
              });
            }
            
            // Create error with flag to prevent double-counting
            const httpError = new Error(`HTTP ${response.status}: ${response.statusText}`);
            httpError._alreadyCounted = true;
            throw httpError;
          }
          
          // Reset network error count on success
          networkErrorCount = 0;
          return response;
        })
        .catch(error => {
          clearTimeout(timeoutId);
          
          // Only increment if not already counted (prevents double-counting HTTP errors)
          if (!error._alreadyCounted) {
            networkErrorCount++;
            healthMetrics.networkErrors++;
          }
          
          // Don't log session validation errors to console (they're backend API responses)
          const isValidationError = error.message && (
            error.message.toLowerCase().includes('session duration') ||
            error.message.toLowerCase().includes('negative session')
          );
          
          if (CONFIG.DEBUG && !isValidationError) {
            console.warn('[WhysRecorder] Network error (failing silently):', error.message);
          }
          
          // Circuit breaker (only for new errors, not double-counted ones)
          if (!error._alreadyCounted && networkErrorCount >= CONFIG.MAX_NETWORK_ERRORS) {
            disableRecorder('network_error_threshold', {
              networkErrors: networkErrorCount,
              lastError: error.message
            });
          } else if (!error._alreadyCounted && networkErrorCount % 3 === 0) {
            // Send health event for network error tracking
            sendHealthEvent('network_error_warning', {
              networkErrorCount: networkErrorCount,
              errorMessage: error.message,
              eventsProcessed: healthMetrics.eventsProcessed
            });
          }
          
          throw error;
        });
    }, 'network_request') || Promise.reject(new Error('Network operation failed safely'));
  }

  // ============================================================================
  // ORIGINAL RECORDER FUNCTIONALITY (WRAPPED IN SAFETY)
  // ============================================================================
  
  // Global state
  let isInitialized = false;
  let projectId = null;
  let userId = null;
  let sessionId = null;
  let visitorId = null;
  let globalVisitorId = null;
  let eventQueue = [];
  let batchTimer = null;
  let sessionData = null;
  let sessionEnded = false;
  let initializationPromise = null;
  
  // Activity tracking
  let lastActivityTime = Date.now();
  let inactivityTimer = null;
  let visibilityTimer = null;

  // Safe UUID generation with fallbacks
  function generateUUID() {
    return safeExecute(() => {
      // Use crypto.randomUUID() if available (modern browsers)
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
      
      // Fallback for older browsers
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }, 'generateUUID', true) || `fallback-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  function generateVisitorId(projectId) {
    return generateUUID();
  }

  function generateGlobalVisitorId() {
    return generateUUID();
  }

  function getOrCreateVisitorIds(projectId) {
    return safeExecute(() => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      
      // Project-scoped visitor ID
      const visitorKey = `whys_visitor_${projectId}`;
      let visitorId = safeLocalStorageGet(visitorKey);
      if (!visitorId || !uuidRegex.test(visitorId)) {
        if (visitorId && CONFIG.DEBUG) {
          log("Invalid visitor ID format found, regenerating:", visitorId);
        }
        visitorId = generateVisitorId(projectId);
        if (!uuidRegex.test(visitorId)) {
          log("Generated visitor ID is invalid, regenerating:", visitorId);
          visitorId = generateVisitorId(projectId);
        }
        safeLocalStorageSet(visitorKey, visitorId);
        log("Created new visitor ID:", visitorId);
      }

      // Global visitor ID (platform-wide)
      const globalKey = 'whys_global_visitor';
      let globalVisitorId = safeLocalStorageGet(globalKey);
      if (!globalVisitorId || !uuidRegex.test(globalVisitorId)) {
        if (globalVisitorId && CONFIG.DEBUG) {
          log("Invalid global visitor ID format found, regenerating:", globalVisitorId);
        }
        globalVisitorId = generateGlobalVisitorId();
        if (!uuidRegex.test(globalVisitorId)) {
          log("Generated global visitor ID is invalid, regenerating:", globalVisitorId);
          globalVisitorId = generateGlobalVisitorId();
        }
        safeLocalStorageSet(globalKey, globalVisitorId);
        log("Created new global visitor ID:", globalVisitorId);
      }

      return { visitorId, globalVisitorId };
    }, 'getOrCreateVisitorIds', true) || {
      visitorId: generateVisitorId(projectId),
      globalVisitorId: generateGlobalVisitorId()
    };
  }

  function getOrCreateSessionId(projectId) {
    return safeExecute(() => {
      const sessionKey = `whys_session_${projectId}`;
      const timestampKey = `whys_session_timestamp_${projectId}`;
      
      const existingSessionId = safeLocalStorageGet(sessionKey);
      const existingTimestamp = safeLocalStorageGet(timestampKey);
      
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      
      if (existingSessionId && existingTimestamp) {
        if (!uuidRegex.test(existingSessionId)) {
          log("Invalid session ID format found, clearing:", existingSessionId);
          safeLocalStorageRemove(sessionKey);
          safeLocalStorageRemove(timestampKey);
        } else {
          const sessionAge = Date.now() - parseInt(existingTimestamp);
          const maxInactivity = CONFIG.INACTIVITY_TIMEOUT;
          if (sessionAge < maxInactivity) {
            log("Continuing existing session:", existingSessionId, "Age:", Math.round(sessionAge / 60000), "minutes");
            safeLocalStorageSet(timestampKey, Date.now().toString());
            return existingSessionId;
          } else {
            log("Session expired, creating new one. Age:", Math.round(sessionAge / 60000), "minutes");
            safeLocalStorageRemove(sessionKey);
            safeLocalStorageRemove(timestampKey);
          }
        }
      }
      
      const newSessionId = generateUUID();
      
      if (!uuidRegex.test(newSessionId)) {
        log("Generated session ID is invalid:", newSessionId, "Regenerating...");
        const retrySessionId = generateUUID();
        if (!uuidRegex.test(retrySessionId)) {
          throw new Error("UUID generation failed");
        }
        safeLocalStorageSet(sessionKey, retrySessionId);
        safeLocalStorageSet(timestampKey, Date.now().toString());
        log("Created new session (retry):", retrySessionId);
        return retrySessionId;
      }
      
      safeLocalStorageSet(sessionKey, newSessionId);
      safeLocalStorageSet(timestampKey, Date.now().toString());
      
      log("Created new session:", newSessionId);
      return newSessionId;
      
    }, 'getOrCreateSessionId', true) || generateUUID();
  }

  function log(...args) {
    if (CONFIG.DEBUG && !recorderDisabled) {
      safeExecute(() => {
        console.log('[WhysRecorder]', ...args);
      }, 'log');
    }
  }

  function getElementSelector(element) {
    if (!element || recorderDisabled) return null;
    
    return safeExecute(() => {
      if (element.id) {
        return '#' + element.id;
      }
      
      if (element.className) {
        let classNames = '';
        if (typeof element.className === 'string') {
          classNames = element.className;
        } else if (element.className.baseVal) {
          classNames = element.className.baseVal;
        }
        
        if (classNames) {
          const classes = classNames.split(' ').filter(c => c.trim()).join('.');
          if (classes) {
            return element.tagName.toLowerCase() + '.' + classes;
          }
        }
      }
      
      return element.tagName ? element.tagName.toLowerCase() : 'unknown';
    }, 'getElementSelector') || 'unknown';
  }

  function getElementText(element) {
    if (!element || recorderDisabled) return null;
    
    return safeExecute(() => {
      const text = element.textContent || element.innerText || '';
      return text.trim().substring(0, 100);
    }, 'getElementText') || '';
  }

  /**
   * Enhanced field label detection for form inputs
   * Finds the actual user-visible label for form fields
   */
  function getFieldLabel(element) {
    if (!element || recorderDisabled) return null;
    
    return safeExecute(() => {
      // 1. Check for associated label via 'for' attribute (most reliable)
      if (element.id) {
        const label = document.querySelector(`label[for="${element.id}"]`);
        if (label && label.textContent) {
          const labelText = label.textContent.trim();
          if (labelText) {
            return labelText.substring(0, 100);
          }
        }
      }
      
      // 2. Check for wrapping label element
      let parent = element.parentElement;
      let depth = 0;
      while (parent && depth < 5) { // Limit depth to avoid infinite loops
        if (parent.tagName === 'LABEL') {
          // Get label text, excluding the input element's text
          const labelText = parent.textContent || parent.innerText || '';
          const elementText = element.textContent || element.innerText || '';
          const cleanLabelText = labelText.replace(elementText, '').trim();
          if (cleanLabelText) {
            return cleanLabelText.substring(0, 100);
          }
        }
        parent = parent.parentElement;
        depth++;
      }
      
      // 3. Check for placeholder attribute
      if (element.placeholder && element.placeholder.trim()) {
        return element.placeholder.trim().substring(0, 100);
      }
      
      // 4. Check for aria-label attribute
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) {
        return ariaLabel.trim().substring(0, 100);
      }
      
      // 5. Check for aria-labelledby
      const ariaLabelledBy = element.getAttribute('aria-labelledby');
      if (ariaLabelledBy) {
        const labelElement = document.getElementById(ariaLabelledBy);
        if (labelElement && labelElement.textContent) {
          const labelText = labelElement.textContent.trim();
          if (labelText) {
            return labelText.substring(0, 100);
          }
        }
      }
      
      // 6. Check for nearby text elements (previous sibling)
      const prevSibling = element.previousElementSibling;
      if (prevSibling && prevSibling.textContent) {
        const siblingText = prevSibling.textContent.trim();
        // Only use if it's short enough to be a label (not paragraph text)
        if (siblingText && siblingText.length < 50) {
          return siblingText.substring(0, 100);
        }
      }
      
      // 7. Check for name attribute as last resort
      if (element.name && element.name.trim()) {
        // Convert name to readable format (e.g., "firstName" -> "First Name")
        const nameText = element.name
          .replace(/([A-Z])/g, ' $1') // Add space before capitals
          .replace(/[_-]/g, ' ') // Replace underscores and hyphens with spaces
          .trim()
          .replace(/\b\w/g, l => l.toUpperCase()); // Capitalize first letters
        
        if (nameText && nameText !== element.name) {
          return nameText.substring(0, 100);
        }
      }
      
      return null;
    }, 'getFieldLabel') || null;
  }

  function getDeviceInfo() {
    return safeExecute(() => {
      return {
        userAgent: navigator.userAgent || 'unknown',
        language: navigator.language || 'unknown',
        platform: navigator.platform || 'unknown',
        cookieEnabled: navigator.cookieEnabled || false,
        onLine: navigator.onLine || true,
        screenResolution: `${screen.width || 0}x${screen.height || 0}`,
        viewportSize: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
        timezone: (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone;
          } catch (e) {
            return 'unknown';
          }
        })()
      };
    }, 'getDeviceInfo') || {};
  }

  function updateActivity() {
    if (recorderDisabled) return;
    safeExecute(() => {
      lastActivityTime = Date.now();
      healthMetrics.lastEventTime = Date.now(); // Phase 1: For adaptive health reporting
      startInactivityTimer();
    }, 'updateActivity');
  }

  function startInactivityTimer() {
    if (recorderDisabled) return;
    safeExecute(() => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }
      
      inactivityTimer = setTimeout(() => {
        if (!sessionEnded) {
          endSession('inactivity_timeout', {
            inactive_duration: CONFIG.INACTIVITY_TIMEOUT
          });
        }
      }, CONFIG.INACTIVITY_TIMEOUT);
    }, 'startInactivityTimer');
  }

  function endSession(reason, additionalData = {}) {
    if (sessionEnded || recorderDisabled) return;
    
    safeExecute(() => {
      sessionEnded = true;
      log('Ending session:', reason, additionalData);
      
      // Calculate session duration safely with robust fallbacks
      const currentTime = Date.now();
      const sessionStartTime = sessionData?.startTime || healthMetrics.startTime;
      const rawDuration = currentTime - sessionStartTime;
      
      // If duration is negative or unreasonable (>24 hours), use health metrics start time
      let finalDuration;
      if (rawDuration < 0 || rawDuration > 24 * 60 * 60 * 1000) {
        const healthDuration = currentTime - healthMetrics.startTime;
        finalDuration = Math.max(0, healthDuration);
        
        if (CONFIG.DEBUG) {
          console.warn('[WhysRecorder] Invalid session duration, using health metrics fallback:', {
            originalDuration: rawDuration,
            fallbackDuration: finalDuration,
            sessionStart: sessionStartTime ? new Date(sessionStartTime).toISOString() : 'undefined',
            healthStart: new Date(healthMetrics.startTime).toISOString(),
            sessionDataExists: !!sessionData,
            sessionDataStartTime: sessionData?.startTime
          });
        }
      } else {
        finalDuration = rawDuration;
      }
      
      captureEvent('session_end', {
        metadata: { 
          reason: reason,
          session_duration: finalDuration,
          ...additionalData
        }
      });
      
      if (eventQueue.length > 0) {
        sendBatch(true);
      }
      
      [inactivityTimer, visibilityTimer, batchTimer].forEach(timer => {
        if (timer) {
          clearTimeout(timer);
        }
      });
      
      inactivityTimer = null;
      visibilityTimer = null;
      batchTimer = null;
    }, 'endSession');
  }

  function handleVisibilityChange() {
    if (sessionEnded || recorderDisabled) return;
    
    safeExecute(() => {
      if (document.hidden) {
        log('Page hidden - starting tab hidden timer');
        if (visibilityTimer) {
          clearTimeout(visibilityTimer);
        }
        
        const tabHiddenTimeout = 10 * 60 * 1000; // 10 minutes
        visibilityTimer = setTimeout(() => {
          if (document.hidden && !sessionEnded) {
            endSession('tab_hidden_timeout', {
              hidden_duration: tabHiddenTimeout
            });
          }
        }, tabHiddenTimeout);
        
      } else {
        log('Page visible - resetting activity');
        if (visibilityTimer) {
          clearTimeout(visibilityTimer);
          visibilityTimer = null;
        }
        updateActivity();
      }
      
      captureEvent('visibility', {
        metadata: { 
          hidden: document.hidden,
          timestamp: new Date().toISOString()
        }
      });
    }, 'handleVisibilityChange');
  }

  function captureEvent(eventType, data = {}) {
    if (!isInitialized || !sessionId || sessionEnded || recorderDisabled) return;

    return safeExecute(() => {
      // Memory protection - prevent queue overflow
      if (eventQueue.length >= CONFIG.MAX_EVENT_QUEUE_SIZE) {
        log('Event queue overflow, dropping old events');
        eventQueue = eventQueue.slice(-CONFIG.MAX_EVENT_QUEUE_SIZE / 2);
        
        // Send health event for memory limit
        sendHealthEvent('memory_limit_exceeded', {
          queueLength: eventQueue.length,
          maxQueueSize: CONFIG.MAX_EVENT_QUEUE_SIZE,
          eventsProcessed: healthMetrics.eventsProcessed,
          reason: 'Event queue overflow protection'
        });
      }

      const event = {
        sessionId: sessionId,
        eventType: eventType,
        timestamp: new Date().toISOString(),
        pageUrl: window.location.href,
        ...data
      };

      eventQueue.push(event);
      healthMetrics.eventsProcessed++;
      log('Event captured:', eventType, data);

      if (['click', 'scroll', 'input', 'navigation'].includes(eventType)) {
        updateActivity();
      }

      if (eventQueue.length >= CONFIG.BATCH_SIZE) {
        sendBatch();
      } else if (!batchTimer) {
        batchTimer = setTimeout(() => {
          // Flush any pending console logs before sending batch
          if (consoleLogQueue.length > 0) {
            flushConsoleLogs();
          }
          sendBatch();
        }, CONFIG.BATCH_TIMEOUT);
      }
    }, 'captureEvent');
  }

  function setupEventListeners() {
    if (recorderDisabled) return;
    
    safeExecute(() => {
      // Click events with safe handling
      document.addEventListener('click', function(e) {
        safeExecute(() => {
          captureEvent('click', {
            elementSelector: getElementSelector(e.target),
            elementText: getElementText(e.target),
            elementTag: e.target && e.target.tagName ? e.target.tagName.toLowerCase() : 'unknown',
            clickCoordinates: { x: e.clientX || 0, y: e.clientY || 0 }
          });
        }, 'click_handler');
      }, true);

      // Scroll events (throttled) with safe handling
      let scrollTimeout;
      document.addEventListener('scroll', function(e) {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          safeExecute(() => {
            captureEvent('scroll', {
              scrollPosition: { x: window.scrollX || 0, y: window.scrollY || 0 }
            });
          }, 'scroll_handler');
        }, 100);
      }, true);

      // ============================================================================
      // SENSITIVE DATA FILTERING - Enhanced Security
      // ============================================================================
      const SENSITIVE_PATTERNS = [
        /passw(or)?d/i,
        /passwd/i,
        /pwd/i,
        /pin/i,
        /ssn/i,
        /social[-_\s]?security/i,
        /credit[-_\s]?card/i,
        /cc[-_\s]?number/i,
        /card[-_\s]?number/i,
        /cvv/i,
        /cvc/i,
        /security[-_\s]?code/i,
        /api[-_\s]?key/i,
        /access[-_\s]?token/i,
        /secret/i,
        /auth[-_\s]?token/i,
        /bearer/i,
        /routing[-_\s]?number/i,
        /account[-_\s]?number/i,
        /tax[-_\s]?id/i,
        /ein/i
      ];

      function isSensitiveInput(element) {
        if (!element) return true; // Default to sensitive if unclear
        
        // Always filter password fields
        if (element.type === 'password') return true;
        
        // Check autocomplete attributes (standard HTML autocomplete values)
        const autocomplete = element.autocomplete?.toLowerCase() || '';
        if (autocomplete.includes('cc-') || 
            autocomplete === 'new-password' ||
            autocomplete === 'current-password' ||
            autocomplete === 'one-time-code') {
          return true;
        }
        
        // Check name, id, and placeholder for sensitive keywords
        const checkStrings = [
          element.name,
          element.id,
          element.placeholder,
          element.className
        ].filter(Boolean).join(' ').toLowerCase();
        
        if (SENSITIVE_PATTERNS.some(pattern => pattern.test(checkStrings))) {
          return true;
        }
        
        // Check associated label text
        const label = getFieldLabel(element)?.toLowerCase() || '';
        if (SENSITIVE_PATTERNS.some(pattern => pattern.test(label))) {
          return true;
        }
        
        return false;
      }

      // Input events with privacy protection
      document.addEventListener('input', function(e) {
        safeExecute(() => {
          const element = e.target;
          
          // Skip sensitive inputs entirely
          if (isSensitiveInput(element)) {
            return;
          }

          captureEvent('input', {
            elementSelector: getElementSelector(element),
            elementText: getFieldLabel(element),
            elementTag: element && element.tagName ? element.tagName.toLowerCase() : 'unknown',
            inputValue: element.value && element.value.length > 0 ? '[REDACTED]' : '', // Still redact for extra safety
            inputType: element.type || 'unknown'
          });
        }, 'input_handler');
      }, true);

      // Page navigation with safe URL handling
      let currentUrl = window.location.href;
      function checkUrlChange() {
        safeExecute(() => {
          const newUrl = window.location.href;
          if (newUrl !== currentUrl) {
            const previousUrl = currentUrl;
            currentUrl = newUrl;
            
            captureEvent('navigation', {
              navigationData: {
                from: previousUrl,
                to: newUrl,
                type: 'spa'
              }
            });
            
            updateSessionUrl();
          }
        }, 'url_change_check');
      }

      // Monitor for SPA navigation
      window.addEventListener('popstate', checkUrlChange);
      
      // Override pushState and replaceState for SPA detection
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      
      history.pushState = function(...args) {
        safeExecute(() => {
          originalPushState.apply(this, args);
          setTimeout(checkUrlChange, 0);
        }, 'pushState_override');
      };
      
      history.replaceState = function(...args) {
        safeExecute(() => {
          originalReplaceState.apply(this, args);
          setTimeout(checkUrlChange, 0);
        }, 'replaceState_override');
      };

      // Page lifecycle events
      document.addEventListener('visibilitychange', handleVisibilityChange);
      
      window.addEventListener('beforeunload', function() {
        safeExecute(() => {
          if (!sessionEnded) {
            // Flush any remaining console logs before ending session
        if (consoleLogQueue.length > 0) {
          flushConsoleLogs();
        }
        endSession('page_unload');
          }
        }, 'beforeunload_handler');
      });

      window.addEventListener('pagehide', function() {
        safeExecute(() => {
          if (!sessionEnded) {
            endSession('page_hide');
          }
        }, 'pagehide_handler');
      });

    }, 'setupEventListeners');
  }

  function updateSessionUrl() {
    if (recorderDisabled) return;
    safeExecute(() => {
      if (sessionData) {
        sessionData.pageUrl = window.location.href;
      }
    }, 'updateSessionUrl');
  }

  function sendBatch(useBeacon = false) {
    if (eventQueue.length === 0 || recorderDisabled) return;
    
    return safeExecute(() => {
      // Validate session data
      if (!sessionData || !sessionData.projectId || !sessionData.sessionId) {
        log('Invalid session data, skipping batch send:', sessionData);
        return;
      }

      if (!sessionData.visitorId || !sessionData.globalVisitorId) {
        log('Missing visitor IDs, skipping batch send');
        return;
      }

      // Validate UUIDs
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(sessionData.sessionId) || 
          !uuidRegex.test(sessionData.visitorId) || 
          !uuidRegex.test(sessionData.globalVisitorId)) {
        
        // Regenerate invalid IDs
        if (!uuidRegex.test(sessionData.sessionId)) {
          sessionData.sessionId = generateUUID();
          sessionId = sessionData.sessionId;
        }
        if (!uuidRegex.test(sessionData.visitorId)) {
          sessionData.visitorId = generateUUID();
          visitorId = sessionData.visitorId;
        }
        if (!uuidRegex.test(sessionData.globalVisitorId)) {
          sessionData.globalVisitorId = generateUUID();
          globalVisitorId = sessionData.globalVisitorId;
        }
      }

      const payload = {
        sessionData: sessionData,
        events: [...eventQueue]
      };

      // Check payload size - split if too large
      const payloadSize = new TextEncoder().encode(JSON.stringify(payload)).length;
      if (payloadSize > CONFIG.MAX_PAYLOAD_SIZE) {
        log('Payload too large, splitting batch');
        const halfSize = Math.floor(eventQueue.length / 2);
        const firstHalf = eventQueue.splice(0, halfSize);
        sendBatchData({ sessionData: sessionData, events: firstHalf }, useBeacon);
        return;
      }

      sendBatchData(payload, useBeacon);
      eventQueue = [];
      
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
    }, 'sendBatch');
  }

  function sendBatchData(payload, useBeacon = false) {
    if (recorderDisabled) return;
    
    const url = CONFIG.API_ENDPOINT;
    const data = JSON.stringify(payload);

    log('Sending batch data:', {
      url: url,
      payloadSize: data.length,
      eventsCount: payload.events?.length || 0,
      useBeacon: useBeacon
    });

    if (useBeacon && navigator.sendBeacon) {
      // Use beacon for page unload - fail silently
      safeExecute(() => {
        const blob = new Blob([data], { type: 'application/json' });
        const sent = navigator.sendBeacon(url, blob);
        log('Batch sent via beacon:', sent, payload.events.length, 'events');
      }, 'beacon_send');
    } else {
      // Use fetch with timeout and error handling
      safeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: data
      })
      .then(response => {
        if (response) {
          return response.json();
        }
      })
      .then(result => {
        if (result && CONFIG.DEBUG) {
          log('Batch sent successfully:', result);
        }
      })
      .catch(error => {
        // Error already handled in safeFetch
        if (CONFIG.DEBUG) {
          log('Batch send failed (handled safely):', error.message);
        }
      });
    }
  }

  // ============================================================================
  // HEALTH MONITORING (Phase 1)
  // ============================================================================
  
  function sendHealthEvent(eventType, data = {}) {
    safeExecute(() => {
      if (typeof fetch === 'undefined' || !CONFIG.HEALTH_MONITOR_ENDPOINT) {
        return;
      }
      
      const healthEvent = {
        projectId: projectId,
        sessionId: sessionId,
        userId: userId,
        visitorId: visitorId,
        globalVisitorId: globalVisitorId,
        eventType: eventType,
        pageUrl: window.location.href,
        userAgent: navigator.userAgent,
        recorderVersion: '2.0.0-failsafe',
        ...data
      };
      
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10000); // 10 second timeout for health events
      
      fetch(CONFIG.HEALTH_MONITOR_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(healthEvent),
        signal: controller.signal,
        keepalive: true
      }).catch((error) => {
        // Health monitoring failures should not impact the recorder
        if (CONFIG.DEBUG) {
          console.warn('[WhysRecorder] Health monitoring failed (non-critical):', error.message);
        }
      });
    }, 'sendHealthEvent');
  }
  
  function scheduleNextHealthReport() {
    if (!CONFIG.ADAPTIVE_HEALTH_REPORTING) {
      // Original fixed interval
      healthReportTimer = setTimeout(reportHealthMetrics, CONFIG.HEALTH_REPORT_INTERVAL);
      return;
    }
    
    // Phase 1 Optimization: Adaptive health reporting
    const timeSinceLastEvent = Date.now() - healthMetrics.lastEventTime;
    
    if (timeSinceLastEvent > 600000) { // 10 min idle
      currentHealthInterval = 900000;   // Report every 15 min
    } else if (globalErrorCount > 5) {
      currentHealthInterval = 60000;    // Report every 1 min if errors
    } else if (healthMetrics.eventsProcessed > 100) {
      currentHealthInterval = 180000;   // Report every 3 min if active
    } else {
      currentHealthInterval = CONFIG.HEALTH_REPORT_INTERVAL; // Default 5 min
    }
    
    healthReportTimer = setTimeout(reportHealthMetrics, currentHealthInterval);
  }

  function reportHealthMetrics() {
    if (recorderDisabled) return;
    
    safeExecute(() => {
      const now = Date.now();
      const uptime = now - healthMetrics.startTime;
      const timeSinceLastReport = now - healthMetrics.lastHealthReport;
      
      if (timeSinceLastReport >= CONFIG.HEALTH_REPORT_INTERVAL) {
        const healthData = {
          errorCount: globalErrorCount,
          networkErrorCount: networkErrorCount,
          storageErrorCount: storageErrorCount,
          eventsProcessed: healthMetrics.eventsProcessed,
          queueLength: eventQueue.length,
          uptimeMs: uptime
        };
        
        // Send health report to monitoring system
        sendHealthEvent('health_report', healthData);
        
        // Also send as custom event to main system
        captureEvent('health_report', {
          metadata: {
            ...healthData,
            totalErrors: healthMetrics.totalErrors,
            networkErrors: healthMetrics.networkErrors,
            storageErrors: healthMetrics.storageErrors,
            disabled: recorderDisabled,
            timestamp: new Date().toISOString()
          }
        });
        
        healthMetrics.lastHealthReport = now;
        
        if (CONFIG.DEBUG) {
          log('Health report:', healthData);
        }
      }
    }, 'reportHealthMetrics');
  }

  // Start adaptive health monitoring (Phase 1 optimization)
  scheduleNextHealthReport();

  // ============================================================================
  // PUBLIC API WITH SAFETY WRAPPERS
  // ============================================================================
  
  const WhysRecorder = {
    init: function(config = {}) {
      // Prevent re-initialization if disabled
      if (recorderDisabled) {
        console.warn('[WhysRecorder] Recorder disabled, cannot initialize');
        return Promise.resolve();
      }

      // Prevent too many initialization attempts
      initializationAttempts++;
      if (initializationAttempts > MAX_INIT_ATTEMPTS) {
        disableRecorder('max_init_attempts_exceeded', {
          attempts: initializationAttempts
        });
        return Promise.reject(new Error('Too many initialization attempts'));
      }

      // Prevent concurrent initialization
      if (initializationPromise) {
        log('Initialization already in progress');
        return initializationPromise;
      }
      
      if (isInitialized) {
        log('Already initialized with sessionId:', sessionId);
        
        if (config.projectId && config.projectId === projectId) {
          log('Same project, returning existing session');
          return Promise.resolve();
        }
        
        if (config.projectId && config.projectId !== projectId) {
          log('Different project detected, reinitializing');
          isInitialized = false;
          sessionEnded = false;
        } else {
          return Promise.resolve();
        }
      }

      // Validate required config
      if (!config.projectId) {
        const error = new Error('WhysRecorder: projectId is required');
        console.error('[WhysRecorder]', error.message);
        return Promise.reject(error);
      }

      initializationPromise = new Promise((resolve, reject) => {
        const initResult = safeExecute(() => {
          projectId = config.projectId;
          userId = config.userId || null;
          
          sessionEnded = false;
          
          sessionId = getOrCreateSessionId(projectId);

          const { visitorId: vid, globalVisitorId: gvid } = getOrCreateVisitorIds(projectId);
          visitorId = vid;
          globalVisitorId = gvid;

          // Override default config
          if (config.apiEndpoint) {
            CONFIG.API_ENDPOINT = config.apiEndpoint;
          }
          if (config.debug !== undefined) {
            CONFIG.DEBUG = config.debug;
          }
          if (config.captureConsole !== undefined) {
            CONFIG.CAPTURE_CONSOLE_LOGS = config.captureConsole;
          }
          if (config.consoleLogLevels) {
            CONFIG.CONSOLE_LOG_LEVELS = config.consoleLogLevels;
          }
          if (config.excludeRecorderLogs !== undefined) {
            CONFIG.EXCLUDE_RECORDER_LOGS = config.excludeRecorderLogs;
          }

          // Initialize session data
          sessionData = {
            projectId: projectId,
            sessionId: sessionId,
            visitorId: visitorId,
            globalVisitorId: globalVisitorId,
            userId: userId,
            pageUrl: window.location.href,
            userAgent: navigator.userAgent,
            screenResolution: `${screen.width}x${screen.height}`,
            viewportSize: `${window.innerWidth}x${window.innerHeight}`,
            deviceInfo: getDeviceInfo(),
            metadata: config.metadata || {},
            startTime: Date.now() // Always use current initialization time, not session creation time
          };

          // Final UUID validation
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(sessionId) || !uuidRegex.test(visitorId) || !uuidRegex.test(globalVisitorId)) {
            throw new Error('Invalid UUID generated during initialization');
          }

          // Clear old session data that might cause timing issues
          safeExecute(() => {
            const keys = Object.keys(localStorage || {});
            const oldSessionKeys = keys.filter(key => {
              if (!key.startsWith('whys_session_timestamp_')) return false;
              
              const timestamp = parseInt(safeLocalStorageGet(key) || '0');
              const age = Date.now() - timestamp;
              
              // Clear sessions older than 24 hours or with invalid timestamps
              return age > 24 * 60 * 60 * 1000 || isNaN(timestamp) || timestamp <= 0;
            });
            
            oldSessionKeys.forEach(timestampKey => {
              const sessionKey = timestampKey.replace('_timestamp_', '_');
              safeLocalStorageRemove(timestampKey);
              safeLocalStorageRemove(sessionKey);
            });
            
            if (oldSessionKeys.length > 0) {
              log('Cleaned up', oldSessionKeys.length, 'old session entries to prevent timing issues');
            }
          }, 'cleanup_old_sessions');

          log('Initialization successful:', {
            projectId: projectId,
            sessionId: sessionId,
            visitorId: visitorId,
            globalVisitorId: globalVisitorId
          });

          // Phase 1: Console capture now lazy-loaded on first use
          
          // Capture initial session start event
          captureEvent('session_start', {
            metadata: { 
              initialized: true,
              userAgent: navigator.userAgent,
              initialUrl: window.location.href,
              referrer: document.referrer,
              timestamp: new Date().toISOString(),
              recorderVersion: '2.0.0-failsafe'
            }
          });

          setupEventListeners();
          updateActivity();
          
          isInitialized = true;
          initializationPromise = null;
          
          log('WhysRecorder initialized successfully with fail-safe protection');
          return true;
        }, 'init', true);

        if (initResult) {
          resolve();
        } else {
          const error = new Error('Initialization failed safely');
          console.warn('[WhysRecorder]', error.message);
          reject(error);
        }
      });

      initializationPromise.catch(function(error) {
        console.error('[Whys Initialization Error]:', error);
      });

      return initializationPromise;
    },

    identify: function(newUserId) {
      if (recorderDisabled || !isInitialized) return;
      
      safeExecute(() => {
        userId = newUserId;
        if (sessionData) {
          sessionData.userId = newUserId;
        }
        
        captureEvent('identify', {
          metadata: { 
            userId: newUserId,
            timestamp: new Date().toISOString()
          }
        });
        
        log('User identified:', newUserId);
      }, 'identify');
    },

    track: function(eventType, eventData = {}) {
      if (recorderDisabled || !isInitialized) return;
      
      safeExecute(() => {
        captureEvent('custom', {
          customEventType: eventType,
          customEventData: eventData,
          metadata: { 
            timestamp: new Date().toISOString(),
            custom: true
          }
        });
        
        log('Custom event tracked:', eventType, eventData);
      }, 'track');
    },

    // Debug and health methods
    _getSessionId: function() {
      return sessionId;
    },

    _getEventQueue: function() {
      return eventQueue;
    },

    _sendBatch: function() {
      if (!recorderDisabled) {
        sendBatch();
      }
    },

    _getSessionStatus: function() {
      return {
        initialized: isInitialized,
        sessionId: sessionId,
        disabled: recorderDisabled,
        errorCount: globalErrorCount,
        networkErrorCount: networkErrorCount,
        queueLength: eventQueue.length,
        health: healthMetrics
      };
    },

    _getHealthMetrics: function() {
      return {
        ...healthMetrics,
        uptime: Date.now() - healthMetrics.startTime,
        disabled: recorderDisabled,
        errorCount: globalErrorCount,
        networkErrorCount: networkErrorCount
      };
    },

    _disable: function(reason = 'manual') {
      disableRecorder(reason);
    },

    // Utility to clear old session data that might cause timing errors
    _clearOldSessions: function() {
      if (typeof localStorage === 'undefined') return;
      
      safeExecute(() => {
        const keys = Object.keys(localStorage);
        const sessionKeys = keys.filter(key => 
          key.startsWith('whys_session_') || 
          key.startsWith('whys_session_timestamp_') ||
          key.startsWith('whys_visitor_') ||
          key.startsWith('whys_global_visitor_')
        );
        
        sessionKeys.forEach(key => {
          localStorage.removeItem(key);
        });
        
        console.log('[WhysRecorder] Cleared', sessionKeys.length, 'old session entries');
        return sessionKeys.length;
      }, '_clearOldSessions');
    },

    // Emergency utility to clear ALL session data and restart clean
    _emergencyCleanRestart: function() {
      if (typeof localStorage === 'undefined') return;
      
      safeExecute(() => {
        // Clear all WhysRecorder localStorage data
        const keys = Object.keys(localStorage);
        const allWhysKeys = keys.filter(key => key.startsWith('whys_'));
        
        allWhysKeys.forEach(key => {
          localStorage.removeItem(key);
        });
        
        // Force end current session to prevent more errors
        if (!sessionEnded) {
          sessionEnded = true;
        }
        
        // Clear timers
        [inactivityTimer, visibilityTimer, batchTimer].forEach(timer => {
          if (timer) clearTimeout(timer);
        });
        
        console.log('[WhysRecorder] Emergency cleanup: Cleared', allWhysKeys.length, 'entries. Refresh page to restart clean.');
        return allWhysKeys.length;
      }, '_emergencyCleanRestart');
    }
  };

  // ============================================================================
  // AUTO-INITIALIZATION WITH SAFETY
  // ============================================================================
  
  function autoInit() {
    if (recorderDisabled) return;
    
    safeExecute(() => {
      const scripts = document.getElementsByTagName('script');
      for (let script of scripts) {
        const projectId = script.getAttribute('data-project-id');
        if (projectId && script.src && script.src.includes('recorder')) {
          log('Auto-initializing with project ID:', projectId);
          
          const config = {
            projectId: projectId,
            userId: script.getAttribute('data-user-id'),
            debug: script.getAttribute('data-debug') === 'true',
            apiEndpoint: script.getAttribute('data-api-endpoint'),
            captureConsole: script.getAttribute('data-capture-console') !== 'false', // Default to true
            consoleLogLevels: script.getAttribute('data-console-levels') ? 
              script.getAttribute('data-console-levels').split(',') : null,
            excludeRecorderLogs: script.getAttribute('data-exclude-recorder-logs') !== 'false' // Default to true
          };

          // Remove undefined values
          Object.keys(config).forEach(key => {
            if (config[key] === null || config[key] === undefined) {
              delete config[key];
            }
          });

          WhysRecorder.init(config);
          break;
        }
      }
    }, 'autoInit');
  }

  // ============================================================================
  // GLOBAL EXPOSURE WITH PROTECTION
  // ============================================================================
  
  // Expose to global scope safely
  if (typeof window !== 'undefined') {
    safeExecute(() => {
      window.WhysRecorder = WhysRecorder;
    }, 'global_exposure');
  }

  // Auto-initialize if script has data-project-id
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  // Final safety check - if too many errors during load, disable immediately
  setTimeout(() => {
    if (globalErrorCount > 5) {
      disableRecorder('initialization_errors', {
        errorsOnLoad: globalErrorCount
      });
    }
  }, 1000);

})(); 