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
    MAX_NETWORK_ERRORS: 10,           // Before circuit breaker activation
    MAX_STORAGE_ERRORS: 5,            // localStorage error tolerance
    
    // Existing timeouts
    INACTIVITY_TIMEOUT: 30 * 60 * 1000, // 30 minutes
    INACTIVITY_CHECK_INTERVAL: 60 * 1000, // 1 minute
    
    // Enhanced debugging for Phase 1
    DEBUG: false, // Production mode with health monitoring
    HEALTH_REPORT_INTERVAL: 300000 // 5 minutes - report health metrics
  };

  // Health monitoring for Phase 1
  const healthMetrics = {
    startTime: Date.now(),
    totalErrors: 0,
    networkErrors: 0,
    storageErrors: 0,
    eventsProcessed: 0,
    lastHealthReport: Date.now()
  };

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
  let initializationPromise = null; // Prevent concurrent initialization
  
  // Activity tracking
  let lastActivityTime = Date.now();
  let inactivityTimer = null;
  let visibilityTimer = null;

  // Performance optimizations configuration
  const PERFORMANCE_CONFIG = {
    MAX_BATCH_SIZE: 50, // Reduced from potential unlimited batching
    BATCH_TIMEOUT: 2000, // Send batch every 2 seconds max
    THROTTLE_DELAY: 100, // Throttle high-frequency events
    MAX_QUEUE_SIZE: 200, // Prevent memory leaks
    DEBOUNCE_DELAY: 50 // Debounce rapid events
  };

  // Performance tracking
  let throttleTimers = new Map();
  let lastEventTimes = new Map();

  // Optimized field label detection with caching
  const labelCache = new WeakMap();

  // Utility functions
  function generateUUID() {
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
  }

  function generateVisitorId(projectId) {
    // Use UUID for project-scoped visitor ID
    return generateUUID();
  }

  function generateGlobalVisitorId() {
    // Use UUID for platform-wide visitor ID
    return generateUUID();
  }

  function getOrCreateVisitorIds(projectId) {
    try {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      
      // Project-scoped visitor ID
      const visitorKey = `whys_visitor_${projectId}`;
      let visitorId = localStorage.getItem(visitorKey);
      if (!visitorId || !uuidRegex.test(visitorId)) {
        if (visitorId) {
          log("Invalid visitor ID format found, regenerating:", visitorId);
        }
        visitorId = generateVisitorId(projectId);
        // Double-check the generated ID
        if (!uuidRegex.test(visitorId)) {
          log("Generated visitor ID is invalid, regenerating:", visitorId);
          visitorId = generateVisitorId(projectId);
        }
        localStorage.setItem(visitorKey, visitorId);
        log("Created new visitor ID:", visitorId);
      }

      // Global visitor ID (platform-wide)
      const globalKey = 'whys_global_visitor';
      let globalVisitorId = localStorage.getItem(globalKey);
      if (!globalVisitorId || !uuidRegex.test(globalVisitorId)) {
        if (globalVisitorId) {
          log("Invalid global visitor ID format found, regenerating:", globalVisitorId);
        }
        globalVisitorId = generateGlobalVisitorId();
        // Double-check the generated ID
        if (!uuidRegex.test(globalVisitorId)) {
          log("Generated global visitor ID is invalid, regenerating:", globalVisitorId);
          globalVisitorId = generateGlobalVisitorId();
        }
        localStorage.setItem(globalKey, globalVisitorId);
        log("Created new global visitor ID:", globalVisitorId);
      }

      return { visitorId, globalVisitorId };
    } catch (error) {
      log("Error with visitor IDs:", error);
      // Fallback to session-based IDs if localStorage fails
      return {
        visitorId: generateVisitorId(projectId),
        globalVisitorId: generateGlobalVisitorId()
      };
    }
  }

  function getOrCreateSessionId(projectId) {
    try {
      const sessionKey = `whys_session_${projectId}`;
      const timestampKey = `whys_session_timestamp_${projectId}`;
      
      // Get existing session ID and timestamp
      const existingSessionId = localStorage.getItem(sessionKey);
      const existingTimestamp = localStorage.getItem(timestampKey);
      
      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      
      if (existingSessionId && existingTimestamp) {
        // Check if the existing session ID is a valid UUID
        if (!uuidRegex.test(existingSessionId)) {
          log("Invalid session ID format found in localStorage, clearing:", existingSessionId);
          localStorage.removeItem(sessionKey);
          localStorage.removeItem(timestampKey);
          // Fall through to create new session
        } else {
          const sessionAge = Date.now() - parseInt(existingTimestamp);
          
          // Reduced session continuation window to 30 minutes (same as inactivity timeout)
          // This prevents accumulating multiple "active" sessions
          const maxInactivity = CONFIG.INACTIVITY_TIMEOUT; // 30 minutes
          if (sessionAge < maxInactivity) {
            log("Continuing existing session:", existingSessionId, "Age:", Math.round(sessionAge / 60000), "minutes");
            
            // Update timestamp to extend session
            localStorage.setItem(timestampKey, Date.now().toString());
            return existingSessionId;
          } else {
            log("Session expired, creating new one. Age:", Math.round(sessionAge / 60000), "minutes");
            // Clear expired session data
            localStorage.removeItem(sessionKey);
            localStorage.removeItem(timestampKey);
          }
        }
      }
      
      // Create new session
      const newSessionId = generateUUID();
      
      // Validate the generated UUID before storing
      if (!uuidRegex.test(newSessionId)) {
        log("Generated session ID is invalid:", newSessionId, "Regenerating...");
        // Try one more time
        const retrySessionId = generateUUID();
        if (!uuidRegex.test(retrySessionId)) {
          log("Critical error: Cannot generate valid UUID");
          throw new Error("UUID generation failed");
        }
        localStorage.setItem(sessionKey, retrySessionId);
        localStorage.setItem(timestampKey, Date.now().toString());
        log("Created new session (retry):", retrySessionId);
        return retrySessionId;
      }
      
      localStorage.setItem(sessionKey, newSessionId);
      localStorage.setItem(timestampKey, Date.now().toString());
      
      log("Created new session:", newSessionId);
      return newSessionId;
      
    } catch (error) {
      log("Error with session ID management:", error);
      // Fallback to generating new session
      const fallbackId = generateUUID();
      log("Using fallback session ID:", fallbackId);
      return fallbackId;
    }
  }

  function log(...args) {
    if (CONFIG.DEBUG) {
      console.log('[WhysRecorder]', ...args);
    }
  }

  function getElementSelector(element) {
    if (!element) return null;
    
    try {
      // Try to get a unique selector
      if (element.id) {
        return '#' + element.id;
      }
      
      // Handle className safely - it might not be a string for SVG elements
      if (element.className) {
        let classNames = '';
        if (typeof element.className === 'string') {
          classNames = element.className;
        } else if (element.className.baseVal) {
          // Handle SVG elements where className is an SVGAnimatedString
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
    } catch (error) {
      log('Error getting element selector:', error);
      return 'unknown';
    }
  }

  function getElementText(element) {
    if (!element) return null;
    
    // Get text content, but limit length
    const text = element.textContent || element.innerText || '';
    return text.trim().substring(0, 100);
  }

  /**
   * Enhanced field label detection for form inputs
   * Finds the actual user-visible label for form fields
   */
  function getFieldLabel(element) {
    if (!element) return null;
    
    // Check cache first for performance
    if (labelCache.has(element)) {
      return labelCache.get(element);
    }
    
    let label = null;
    
    try {
      // 1. Check for associated label via 'for' attribute (most reliable)
      if (element.id) {
        const labelElement = document.querySelector(`label[for="${element.id}"]`);
        if (labelElement?.textContent) {
          const labelText = labelElement.textContent.trim();
          if (labelText) {
            label = labelText.substring(0, 100);
          }
        }
      }
      
      // 2. Check for wrapping label element (optimized traversal)
      if (!label) {
        let parent = element.parentElement;
        let depth = 0;
        while (parent && depth < 3) { // Reduced depth for performance
          if (parent.tagName === 'LABEL') {
            const labelText = parent.textContent || parent.innerText || '';
            const elementText = element.textContent || element.innerText || '';
            const cleanLabelText = labelText.replace(elementText, '').trim();
            if (cleanLabelText) {
              label = cleanLabelText.substring(0, 100);
              break;
            }
          }
          parent = parent.parentElement;
          depth++;
        }
      }
      
      // 3. Quick attribute checks
      if (!label) {
        label = element.placeholder?.trim()?.substring(0, 100) ||
                element.getAttribute('aria-label')?.trim()?.substring(0, 100) ||
                null;
      }
      
      // 4. Aria-labelledby (only if needed)
      if (!label) {
        const ariaLabelledBy = element.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
          const labelElement = document.getElementById(ariaLabelledBy);
          if (labelElement?.textContent) {
            label = labelElement.textContent.trim().substring(0, 100);
          }
        }
      }
      
      // 5. Previous sibling check (optimized)
      if (!label) {
        const prevSibling = element.previousElementSibling;
        if (prevSibling?.textContent) {
          const siblingText = prevSibling.textContent.trim();
          if (siblingText && siblingText.length < 50) {
            label = siblingText.substring(0, 100);
          }
        }
      }
      
      // 6. Name attribute as last resort
      if (!label && element.name?.trim()) {
        const nameText = element.name
          .replace(/([A-Z])/g, ' $1')
          .replace(/[_-]/g, ' ')
          .trim()
          .replace(/\b\w/g, l => l.toUpperCase());
        
        if (nameText && nameText !== element.name) {
          label = nameText.substring(0, 100);
        }
      }
      
      // Cache the result
      labelCache.set(element, label);
      return label;
      
    } catch (error) {
      log('Error getting field label:', error);
      labelCache.set(element, null);
      return null;
    }
  }

  function getDeviceInfo() {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      screenResolution: `${screen.width}x${screen.height}`,
      viewportSize: `${window.innerWidth}x${window.innerHeight}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
  }

  // Activity tracking and session ending
  function updateActivity() {
    if (sessionEnded) return;
    
    lastActivityTime = Date.now();
    log('Activity updated:', new Date(lastActivityTime).toISOString());
    
    // Update session timestamp in localStorage to keep session alive
    try {
      if (projectId) {
        const timestampKey = `whys_session_timestamp_${projectId}`;
        localStorage.setItem(timestampKey, Date.now().toString());
      }
    } catch (error) {
      log('Error updating session timestamp:', error);
    }
    
    // Reset inactivity timer
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
    }
    startInactivityTimer();
  }

  function startInactivityTimer() {
    if (sessionEnded) return;
    
    inactivityTimer = setTimeout(() => {
      if (!sessionEnded && Date.now() - lastActivityTime >= CONFIG.INACTIVITY_TIMEOUT) {
        endSession('inactivity_timeout');
      }
    }, CONFIG.INACTIVITY_CHECK_INTERVAL);
  }

  function endSession(reason, additionalData = {}) {
    if (sessionEnded) {
      log('Session already ended, skipping');
      return;
    }
    
    sessionEnded = true;
    log('Ending session with reason:', reason);
    
    // Clear timers
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    if (visibilityTimer) {
      clearTimeout(visibilityTimer);
      visibilityTimer = null;
    }
    
    // Always clear session from localStorage when session ends
    // This ensures that closed tabs don't leave "active" sessions
    try {
      if (projectId) {
        const sessionKey = `whys_session_${projectId}`;
        const timestampKey = `whys_session_timestamp_${projectId}`;
        localStorage.removeItem(sessionKey);
        localStorage.removeItem(timestampKey);
        log('Cleared session from localStorage');
      }
    } catch (error) {
      log('Error clearing session from localStorage:', error);
    }
    
    // Send session end event
    const currentTime = Date.now();
    const startTime = sessionData?.startTime || currentTime;
    const sessionDuration = Math.max(0, currentTime - startTime); // Ensure non-negative duration
    
    captureEvent('session_end', {
      reason: reason,
      last_activity: new Date(lastActivityTime).toISOString(),
      session_duration: sessionDuration,
      ...additionalData
    });
    
    // Force send remaining events
    sendBatch(true);
    
    log('Session ended:', reason);
  }

  function handleVisibilityChange() {
    if (sessionEnded) return;
    
    if (document.hidden) {
      log('Page hidden - starting tab hidden timer');
      // When page is hidden, start a shorter timeout for tab closure
      // End session after 10 minutes when tab is hidden (reduced from 2 hours)
      if (visibilityTimer) {
        clearTimeout(visibilityTimer);
      }
      
      // Shorter timeout when tab is hidden to prevent session accumulation
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
      // Page became visible again
      if (visibilityTimer) {
        clearTimeout(visibilityTimer);
        visibilityTimer = null;
      }
      updateActivity();
    }
    
    // Always capture visibility change
    captureEvent('visibility', {
      metadata: { 
        hidden: document.hidden,
        timestamp: new Date().toISOString()
      }
    });
  }

  // Optimized event capture with performance controls
  function captureEvent(eventType, data = {}) {
    if (!isInitialized || !sessionId || sessionEnded) return;

    // Throttle high-frequency events
    const now = Date.now();
    const lastTime = lastEventTimes.get(eventType) || 0;
    
    if (['scroll', 'mousemove'].includes(eventType) && now - lastTime < PERFORMANCE_CONFIG.THROTTLE_DELAY) {
      return; // Skip this event
    }
    
    // Debounce rapid identical events
    if (['input', 'resize'].includes(eventType)) {
      const timerId = throttleTimers.get(eventType);
      if (timerId) {
        clearTimeout(timerId);
      }
      
      throttleTimers.set(eventType, setTimeout(() => {
        captureEventImmediate(eventType, data);
        throttleTimers.delete(eventType);
      }, PERFORMANCE_CONFIG.DEBOUNCE_DELAY));
      
      return;
    }
    
    lastEventTimes.set(eventType, now);
    captureEventImmediate(eventType, data);
  }

  function captureEventImmediate(eventType, data = {}) {
    // Queue size management to prevent memory leaks
    if (eventQueue.length >= PERFORMANCE_CONFIG.MAX_QUEUE_SIZE) {
      log('Event queue full, forcing batch send');
      sendBatch();
    }

    const event = {
      sessionId: sessionId,
      eventType: eventType,
      timestamp: new Date().toISOString(),
      pageUrl: window.location.href,
      ...data
    };

    eventQueue.push(event);
    log('Event captured:', eventType, data);

    // Update activity for user interaction events
    if (['click', 'scroll', 'input', 'navigation'].includes(eventType)) {
      updateActivity();
    }

    // Optimized batch sending
    if (eventQueue.length >= PERFORMANCE_CONFIG.MAX_BATCH_SIZE) {
      sendBatch();
    } else if (!batchTimer) {
      batchTimer = setTimeout(sendBatch, PERFORMANCE_CONFIG.BATCH_TIMEOUT);
    }
  }

  function setupEventListeners() {
    // Click events
    document.addEventListener('click', function(e) {
      try {
        captureEvent('click', {
          elementSelector: getElementSelector(e.target),
          elementText: getElementText(e.target),
          elementTag: e.target && e.target.tagName ? e.target.tagName.toLowerCase() : 'unknown',
          clickCoordinates: { x: e.clientX, y: e.clientY }
        });
      } catch (error) {
        log('Error capturing click event:', error);
      }
    }, true);

    // Scroll events (throttled)
    let scrollTimeout;
    document.addEventListener('scroll', function(e) {
      try {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          captureEvent('scroll', {
            scrollPosition: { x: window.scrollX, y: window.scrollY }
          });
        }, 100);
      } catch (error) {
        log('Error capturing scroll event:', error);
      }
    }, true);

    // Input events (non-sensitive data only)
    document.addEventListener('input', function(e) {
      try {
        const element = e.target;
        
        // Skip sensitive inputs
        if (element.type === 'password' || 
            element.type === 'email' || 
            element.autocomplete === 'cc-number' ||
            element.name?.toLowerCase().includes('password') ||
            element.name?.toLowerCase().includes('credit') ||
            element.name?.toLowerCase().includes('ssn')) {
          return;
        }

        captureEvent('input', {
          elementSelector: getElementSelector(element),
          elementText: getFieldLabel(element), // Enhanced field label detection
          elementTag: element && element.tagName ? element.tagName.toLowerCase() : 'unknown',
          inputValue: element.value && element.value.length > 0 ? '[REDACTED]' : '', // Don't capture actual values
          inputType: element.type || 'unknown'
        });
      } catch (error) {
        log('Error capturing input event:', error);
      }
    }, true);

    // Page navigation
    let currentUrl = window.location.href;
    function checkUrlChange() {
      if (window.location.href !== currentUrl) {
        captureEvent('navigation', {
          navigationData: {
            from: currentUrl,
            to: window.location.href,
            type: 'spa'
          }
        });
        currentUrl = window.location.href;
        updateSessionUrl();
      }
    }

    // Check for URL changes (for SPAs)
    setInterval(checkUrlChange, 1000);

    // Page unload - send session end event
    window.addEventListener('beforeunload', function() {
      if (!sessionEnded) {
        endSession('page_unload');
      }
    });

    // Page hide - additional coverage for tab close scenarios
    window.addEventListener('pagehide', function() {
      if (!sessionEnded) {
        endSession('page_hide');
      }
    });

    // Enhanced visibility change handling
    document.addEventListener('visibilitychange', function() {
      handleVisibilityChange();
    });

    // Additional activity tracking
    document.addEventListener('keydown', function() {
      updateActivity();
    }, true);

    document.addEventListener('mousemove', function() {
      // Throttle mousemove to avoid excessive activity updates
      if (!updateActivity.lastMouseMove || Date.now() - updateActivity.lastMouseMove > 5000) {
        updateActivity();
        updateActivity.lastMouseMove = Date.now();
      }
    }, true);

    document.addEventListener('touchstart', function() {
      updateActivity();
    }, true);
  }

  function updateSessionUrl() {
    if (sessionData) {
      sessionData.pageUrl = window.location.href;
    }
  }

  // Data sending functions
  function sendBatch(useBeacon = false) {
    if (eventQueue.length === 0) return;
    
    // Validate session data before sending
    if (!sessionData || !sessionData.projectId || !sessionData.sessionId) {
      log('Invalid session data, skipping batch send:', sessionData);
      return;
    }

    // Additional validation for required fields that cause 400 errors
    if (!sessionData.visitorId || !sessionData.globalVisitorId) {
      log('Missing visitor IDs, skipping batch send:', {
        visitorId: sessionData.visitorId,
        globalVisitorId: sessionData.globalVisitorId,
        sessionData: sessionData
      });
      return;
    }

    // Validate that IDs are proper UUIDs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(sessionData.sessionId) || 
        !uuidRegex.test(sessionData.visitorId) || 
        !uuidRegex.test(sessionData.globalVisitorId)) {
      log('Invalid UUID format detected, attempting to fix:', {
        sessionId: sessionData.sessionId,
        sessionIdValid: uuidRegex.test(sessionData.sessionId),
        visitorId: sessionData.visitorId,
        visitorIdValid: uuidRegex.test(sessionData.visitorId),
        globalVisitorId: sessionData.globalVisitorId,
        globalVisitorIdValid: uuidRegex.test(sessionData.globalVisitorId)
      });
      
      // Try to regenerate invalid IDs
      if (!uuidRegex.test(sessionData.sessionId)) {
        sessionData.sessionId = generateUUID();
        sessionId = sessionData.sessionId;
        log('Regenerated sessionId:', sessionData.sessionId);
      }
      if (!uuidRegex.test(sessionData.visitorId)) {
        sessionData.visitorId = generateUUID();
        visitorId = sessionData.visitorId;
        log('Regenerated visitorId:', sessionData.visitorId);
      }
      if (!uuidRegex.test(sessionData.globalVisitorId)) {
        sessionData.globalVisitorId = generateUUID();
        globalVisitorId = sessionData.globalVisitorId;
        log('Regenerated globalVisitorId:', sessionData.globalVisitorId);
      }
    }

    const payload = {
      sessionData: sessionData,
      events: [...eventQueue]
    };

    // Check payload size
    const payloadSize = new TextEncoder().encode(JSON.stringify(payload)).length;
    if (payloadSize > CONFIG.MAX_PAYLOAD_SIZE) {
      log('Payload too large, splitting batch');
      // Split the batch and try again
      const halfSize = Math.floor(eventQueue.length / 2);
      const firstHalf = eventQueue.splice(0, halfSize);
      sendBatchData({ sessionData: sessionData, events: firstHalf }, useBeacon);
      // Remaining events will be sent in next batch
      return;
    }

    sendBatchData(payload, useBeacon);
    eventQueue = [];
    
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
  }

  // Rate limiting configuration
  const RATE_LIMIT_CONFIG = {
    MIN_RETRY_DELAY: 1000,    // 1 second
    MAX_RETRY_DELAY: 60000,   // 1 minute
    BACKOFF_FACTOR: 2,        // Exponential backoff multiplier
    MAX_RETRIES: 5            // Maximum number of retries
  };

  // Rate limiting state
  let rateLimitState = {
    retryCount: 0,
    lastRetryDelay: RATE_LIMIT_CONFIG.MIN_RETRY_DELAY,
    lastErrorTime: 0,
    consecutiveErrors: 0
  };

  // Reset rate limit state
  function resetRateLimitState() {
    rateLimitState.retryCount = 0;
    rateLimitState.lastRetryDelay = RATE_LIMIT_CONFIG.MIN_RETRY_DELAY;
    rateLimitState.lastErrorTime = 0;
    rateLimitState.consecutiveErrors = 0;
  }

  // Calculate next retry delay with exponential backoff
  function calculateRetryDelay(retryAfter) {
    // If server provides retry-after, use it
    if (retryAfter) {
      return Math.min(retryAfter * 1000, RATE_LIMIT_CONFIG.MAX_RETRY_DELAY);
    }

    // Calculate exponential backoff
    const delay = rateLimitState.lastRetryDelay * RATE_LIMIT_CONFIG.BACKOFF_FACTOR;
    
    // Ensure delay is within bounds
    return Math.min(
      Math.max(delay, RATE_LIMIT_CONFIG.MIN_RETRY_DELAY),
      RATE_LIMIT_CONFIG.MAX_RETRY_DELAY
    );
  }

  // Enhanced batch sending with rate limit handling
  async function sendBatchWithRetry(payload, useBeacon) {
    try {
      const response = await fetch(CONFIG.API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '0');
        const resetTime = parseInt(response.headers.get('X-RateLimit-Reset') || '0');
        
        // Update rate limit state
        rateLimitState.retryCount++;
        rateLimitState.lastRetryDelay = calculateRetryDelay(retryAfter);
        rateLimitState.lastErrorTime = Date.now();
        rateLimitState.consecutiveErrors++;

        // Log rate limit info
        log('Rate limit exceeded:', {
          retryAfter,
          resetTime: new Date(resetTime * 1000).toISOString(),
          nextRetryDelay: rateLimitState.lastRetryDelay,
          retryCount: rateLimitState.retryCount
        });

        // Check if we should retry
        if (rateLimitState.retryCount < RATE_LIMIT_CONFIG.MAX_RETRIES) {
          // Wait for the calculated delay
          await new Promise(resolve => setTimeout(resolve, rateLimitState.lastRetryDelay));
          
          // Retry the request
          return sendBatchWithRetry(payload, useBeacon);
        } else {
          // Max retries reached - drop the batch
          log('Max retries reached, dropping batch');
          throw new Error('Rate limit exceeded and max retries reached');
        }
      }

      // Reset rate limit state on success
      if (response.ok) {
        resetRateLimitState();
      }

      return response;
    } catch (error) {
      // Handle network errors
      rateLimitState.consecutiveErrors++;
      
      if (rateLimitState.consecutiveErrors >= RATE_LIMIT_CONFIG.MAX_RETRIES) {
        // Too many consecutive errors - trigger circuit breaker
        log('Circuit breaker triggered due to consecutive errors');
        throw new Error('Circuit breaker triggered');
      }

      throw error;
    }
  }

  // Update the original sendBatchData function to use the new retry mechanism
  function sendBatchData(payload, useBeacon = false) {
    const url = CONFIG.API_ENDPOINT;
    const data = JSON.stringify(payload);

    // Debug logging
    log('Sending batch data:', {
      url: url,
      payloadSize: data.length,
      sessionDataStructure: {
        hasSessionData: !!payload.sessionData,
        projectId: payload.sessionData?.projectId,
        sessionId: payload.sessionData?.sessionId,
        visitorId: payload.sessionData?.visitorId,
        globalVisitorId: payload.sessionData?.globalVisitorId,
        sessionDataKeys: payload.sessionData ? Object.keys(payload.sessionData) : null
      },
      eventsCount: payload.events?.length || 0,
      rateLimitState: { ...rateLimitState }
    });

    if (useBeacon && navigator.sendBeacon) {
      // Use beacon for page unload (no retry for beacons)
      const blob = new Blob([data], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
      log('Batch sent via beacon:', payload.events.length, 'events');
    } else {
      // Use fetch with retry mechanism
      sendBatchWithRetry(payload)
        .then(response => {
          if (!response.ok) {
            return response.json().then(errorData => {
              log('HTTP Error Response:', {
                status: response.status,
                statusText: response.statusText,
                errorData: errorData,
                rateLimitInfo: {
                  limit: response.headers.get('X-RateLimit-Limit'),
                  remaining: response.headers.get('X-RateLimit-Remaining'),
                  reset: response.headers.get('X-RateLimit-Reset')
                }
              });
              throw new Error(`HTTP ${response.status}: ${JSON.stringify(errorData)}`);
            });
          }
          return response.json();
        })
        .then(result => {
          log('Batch sent successfully:', result);
        })
        .catch(error => {
          log('Error sending batch:', error);
          
          // Update health metrics
          healthMetrics.networkErrors++;
          if (healthMetrics.networkErrors >= CONFIG.MAX_NETWORK_ERRORS) {
            log('Network error threshold exceeded, disabling recorder');
            recorderDisabled = true;
          }
        });
    }
  }

  // Enhanced initialization state tracking
  let initializationState = {
    scriptLoaded: false,
    configValidated: false,
    idsGenerated: false,
    initialized: false,
    error: null,
    retryCount: 0,
    maxRetries: 3,
    retryDelay: 100 // ms
  };

  // Validate configuration
  function validateConfig(config) {
    const errors = [];
    
    // Required fields
    if (!config.projectId) {
      errors.push('projectId is required');
    } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.projectId)) {
      errors.push('projectId must be a valid UUID');
    }

    // Optional fields with validation
    if (config.userId && typeof config.userId !== 'string') {
      errors.push('userId must be a string');
    }

    if (config.debug !== undefined && typeof config.debug !== 'boolean') {
      errors.push('debug must be a boolean');
    }

    if (config.batchSize !== undefined) {
      const batchSize = parseInt(config.batchSize);
      if (isNaN(batchSize) || batchSize < 1 || batchSize > 1000) {
        errors.push('batchSize must be a number between 1 and 1000');
      }
    }

    if (config.flushInterval !== undefined) {
      const flushInterval = parseInt(config.flushInterval);
      if (isNaN(flushInterval) || flushInterval < 1000 || flushInterval > 30000) {
        errors.push('flushInterval must be between 1000ms and 30000ms');
      }
    }

    return errors;
  }

  // Enhanced initialization function
  async function initializeRecorder(config) {
    try {
      // Prevent concurrent initialization
      if (initializationPromise) {
        log('Initialization already in progress');
        return initializationPromise;
      }

      // Validate configuration
      const configErrors = validateConfig(config);
      if (configErrors.length > 0) {
        throw new Error('Invalid configuration: ' + configErrors.join(', '));
      }
      initializationState.configValidated = true;

      // Generate IDs
      const { visitorId: vid, globalVisitorId: gvid } = getOrCreateVisitorIds(config.projectId);
      const sid = getOrCreateSessionId(config.projectId);
      
      // Validate generated IDs
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(sid) || !uuidRegex.test(vid) || !uuidRegex.test(gvid)) {
        throw new Error('Failed to generate valid UUIDs');
      }
      
      // Set global state
      projectId = config.projectId;
      userId = config.userId || null;
      sessionId = sid;
      visitorId = vid;
      globalVisitorId = gvid;
      initializationState.idsGenerated = true;

      // Initialize session data
      sessionData = {
        projectId: projectId,
        sessionId: sessionId,
        visitorId: visitorId,
        globalVisitorId: globalVisitorId,
        userId: userId,
        pageUrl: window.location.href,
        userAgent: navigator.userAgent,
        screenResolution: `${window.screen.width}x${window.screen.height}`,
        viewportSize: `${window.innerWidth}x${window.innerHeight}`,
        deviceInfo: getDeviceInfo()
      };

      // Set up event listeners
      setupEventListeners();
      startInactivityTimer();

      // Mark as initialized
      isInitialized = true;
      initializationState.initialized = true;
      log('Recorder initialized successfully');

      return true;
    } catch (error) {
      initializationState.error = error;
      log('Initialization error:', error);
      throw error;
    }
  }

  // Public API
  const WhysRecorder = {
    init: function(config = {}) {
      return initializeRecorder(config);
    },

    identify: function(newUserId) {
      if (!isInitialized) {
        log('Not initialized. Call init() first.');
        return;
      }

      userId = newUserId;
      sessionData.userId = userId;
      
      captureEvent('identify', {
        metadata: { userId: userId }
      });
      
      log('User identified:', userId);
    },

    track: function(eventType, data = {}) {
      if (!isInitialized) {
        log('Not initialized. Call init() first.');
        return;
      }

      captureEvent(eventType, {
        metadata: data
      });
    },

    // Internal methods for debugging
    _getSessionId: function() {
      return sessionId;
    },

    _getVisitorId: function() {
      return visitorId;
    },

    _getGlobalVisitorId: function() {
      return globalVisitorId;
    },

    _getEventQueue: function() {
      return [...eventQueue];
    },

    _sendBatch: function() {
      sendBatch();
    },

    _getSessionStatus: function() {
      if (!projectId) return { error: 'Not initialized' };
      
      try {
        const sessionKey = `whys_session_${projectId}`;
        const timestampKey = `whys_session_timestamp_${projectId}`;
        const storedSessionId = localStorage.getItem(sessionKey);
        const storedTimestamp = localStorage.getItem(timestampKey);
        
        return {
          currentSessionId: sessionId,
          storedSessionId: storedSessionId,
          sessionMatches: sessionId === storedSessionId,
          storedTimestamp: storedTimestamp ? new Date(parseInt(storedTimestamp)).toISOString() : null,
          sessionAge: storedTimestamp ? Date.now() - parseInt(storedTimestamp) : null,
          sessionExpiry: CONFIG.INACTIVITY_TIMEOUT,
          isExpired: storedTimestamp ? (Date.now() - parseInt(storedTimestamp)) > CONFIG.INACTIVITY_TIMEOUT : true,
          lastActivity: new Date(lastActivityTime).toISOString(),
          sessionEnded: sessionEnded
        };
      } catch (error) {
        return { error: error.message };
      }
    }
  };

  // Enhanced auto-initialization
  function autoInit() {
    const scripts = document.getElementsByTagName('script');
    let recorderScript = null;
    let config = null;

    // Find the recorder script
    for (let script of scripts) {
      if (script.src && script.src.includes('recorder.js')) {
        recorderScript = script;
        break;
      }
    }

    if (!recorderScript) {
      log('Recorder script not found');
      return;
    }

    // Extract configuration from data attributes
    const projectId = recorderScript.getAttribute('data-project-id');
    if (!projectId) {
      log('No project ID found in data attributes');
      return;
    }

    // Build configuration
    config = {
      projectId: projectId,
      userId: recorderScript.getAttribute('data-user-id'),
      debug: recorderScript.getAttribute('data-debug') === 'true',
      batchSize: parseInt(recorderScript.getAttribute('data-batch-size')) || undefined,
      flushInterval: parseInt(recorderScript.getAttribute('data-flush-interval')) || undefined
    };

    // Remove undefined values
    Object.keys(config).forEach(key => {
      if (config[key] === null || config[key] === undefined) {
        delete config[key];
      }
    });

    // Initialize with retry mechanism
    function tryInitialize() {
      if (initializationState.retryCount >= initializationState.maxRetries) {
        log('Max initialization retries reached');
        return;
      }

      try {
        WhysRecorder.init(config).catch(error => {
          log('Initialization attempt failed:', error);
          initializationState.retryCount++;
          setTimeout(tryInitialize, initializationState.retryDelay);
        });
      } catch (error) {
        log('Initialization attempt failed:', error);
        initializationState.retryCount++;
        setTimeout(tryInitialize, initializationState.retryDelay);
      }
    }

    // Start initialization
    tryInitialize();
  }

  // Expose to global scope
  window.WhysRecorder = WhysRecorder;

  // Auto-initialize if script has data-project-id
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

})(); 
