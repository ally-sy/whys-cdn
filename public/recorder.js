(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    API_ENDPOINT: 'https://yyfmygwfyxeroqcyhoab.supabase.co/functions/v1/record-session', // Production endpoint
    BATCH_SIZE: 50,
    BATCH_TIMEOUT: 5000, // 5 seconds
    MAX_PAYLOAD_SIZE: 500 * 1024, // 500KB
    INACTIVITY_TIMEOUT: 30 * 60 * 1000, // 30 minutes
    INACTIVITY_CHECK_INTERVAL: 60 * 1000, // Check every minute
    DEBUG: false // Production mode
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

  // Utility functions
  function generateVisitorId(projectId) {
    // Use UUID for project-scoped visitor ID
    return crypto.randomUUID();
  }

  function generateGlobalVisitorId() {
    // Use UUID for platform-wide visitor ID
    return crypto.randomUUID();
  }

  function getOrCreateVisitorIds(projectId) {
    try {
      // Project-scoped visitor ID
      const visitorKey = `whys_visitor_${projectId}`;
      let visitorId = localStorage.getItem(visitorKey);
      if (!visitorId) {
        visitorId = generateVisitorId(projectId);
        localStorage.setItem(visitorKey, visitorId);
        log("Created new visitor ID:", visitorId);
      }

      // Global visitor ID (platform-wide)
      const globalKey = 'whys_global_visitor';
      let globalVisitorId = localStorage.getItem(globalKey);
      if (!globalVisitorId) {
        globalVisitorId = generateGlobalVisitorId();
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
      
      if (existingSessionId && existingTimestamp) {
        const sessionAge = Date.now() - parseInt(existingTimestamp);
        
        // Check if session is still valid (not expired)
        // Allow much longer session continuity - up to 2 hours of inactivity
        const maxInactivity = CONFIG.INACTIVITY_TIMEOUT * 4; // 2 hours
        if (sessionAge < maxInactivity) {
          log("Continuing existing session:", existingSessionId, "Age:", Math.round(sessionAge / 60000), "minutes");
          
          // Update timestamp to extend session
          localStorage.setItem(timestampKey, Date.now().toString());
          return existingSessionId;
        } else {
          log("Session expired, creating new one. Age:", Math.round(sessionAge / 60000), "minutes");
        }
      }
      
      // Create new session
      const newSessionId = crypto.randomUUID();
      localStorage.setItem(sessionKey, newSessionId);
      localStorage.setItem(timestampKey, Date.now().toString());
      
      log("Created new session:", newSessionId);
      return newSessionId;
      
    } catch (error) {
      log("Error with session ID management:", error);
      // Fallback to generating new session
      return crypto.randomUUID();
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
    captureEvent('session_end', {
      reason: reason,
      last_activity: new Date(lastActivityTime).toISOString(),
      session_duration: Date.now() - (sessionData?.startTime || Date.now()),
      ...additionalData
    });
    
    // Force send remaining events
    sendBatch(true);
    
    log('Session ended:', reason);
  }

  function handleVisibilityChange() {
    if (sessionEnded) return;
    
    if (document.hidden) {
      log('Page hidden - starting extended inactivity timer');
      // When page is hidden, start a much longer timeout for inactivity
      // Only end session after a longer period when tab is hidden
      if (visibilityTimer) {
        clearTimeout(visibilityTimer);
      }
      
      // Increased timeout to 2 hours when tab is hidden to avoid premature session ending
      visibilityTimer = setTimeout(() => {
        if (document.hidden && !sessionEnded) {
          endSession('tab_hidden_timeout', {
            hidden_duration: CONFIG.INACTIVITY_TIMEOUT * 4 // 2 hours when hidden
          });
        }
      }, CONFIG.INACTIVITY_TIMEOUT * 4); // 2 hours when tab is hidden
      
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

  // Event capture functions
  function captureEvent(eventType, data = {}) {
    if (!isInitialized || !sessionId || sessionEnded) return;

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

    // Check if we should send batch
    if (eventQueue.length >= CONFIG.BATCH_SIZE) {
      sendBatch();
    } else if (!batchTimer) {
      batchTimer = setTimeout(sendBatch, CONFIG.BATCH_TIMEOUT);
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

    const payload = {
      session: sessionData,
      events: [...eventQueue]
    };

    // Check payload size
    const payloadSize = new TextEncoder().encode(JSON.stringify(payload)).length;
    if (payloadSize > CONFIG.MAX_PAYLOAD_SIZE) {
      log('Payload too large, splitting batch');
      // Split the batch and try again
      const halfSize = Math.floor(eventQueue.length / 2);
      const firstHalf = eventQueue.splice(0, halfSize);
      sendBatchData({ session: sessionData, events: firstHalf }, useBeacon);
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

  function sendBatchData(payload, useBeacon = false) {
    const url = CONFIG.API_ENDPOINT;
    const data = JSON.stringify(payload);

    if (useBeacon && navigator.sendBeacon) {
      // Use beacon for page unload
      const blob = new Blob([data], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
      log('Batch sent via beacon:', payload.events.length, 'events');
    } else {
      // Use fetch for normal sending
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: data,
        keepalive: true
      })
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then(result => {
        log('Batch sent successfully:', result);
      })
      .catch(error => {
        log('Error sending batch:', error);
        // Could implement retry logic here
      });
    }
  }

  // Public API
  const WhysRecorder = {
    init: function(config = {}) {
      // Prevent concurrent initialization
      if (initializationPromise) {
        log('Initialization already in progress, returning existing promise');
        return initializationPromise;
      }
      
      if (isInitialized) {
        log('Already initialized with sessionId:', sessionId);
        
        // Check if this is the same project
        if (config.projectId && config.projectId === projectId) {
          log('Same project, returning existing session');
          return Promise.resolve();
        }
        
        // Different project, need to reinitialize
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
        throw new Error('WhysRecorder: projectId is required');
      }

      initializationPromise = new Promise((resolve) => {
        try {
          projectId = config.projectId;
          userId = config.userId || null;
          
          // Reset session ended flag for new initialization
          sessionEnded = false;
          
          sessionId = getOrCreateSessionId(projectId);

          // Generate visitor IDs
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
            startTime: Date.now()
          };

          // Ensure lastActivityTime is synchronized with session start
          lastActivityTime = sessionData.startTime;

          // Setup event listeners only once
          if (!isInitialized) {
            setupEventListeners();
          }
          
          // Start activity tracking
          updateActivity();
          
          isInitialized = true;
          log('Initialized with projectId:', projectId, 'sessionId:', sessionId, 'visitorId:', visitorId);

          // Send initial session data
          captureEvent('session_start', {
            metadata: { initialized: true }
          });
          
          initializationPromise = null;
          resolve();
        } catch (error) {
          log('Error during initialization:', error);
          initializationPromise = null;
          throw error;
        }
      });
      
      return initializationPromise;
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

  // Auto-initialization from script tag
  function autoInit() {
    const scripts = document.getElementsByTagName('script');
    for (let script of scripts) {
      const projectId = script.getAttribute('data-project-id');
      if (projectId && script.src && script.src.includes('recorder.js')) {
        log('Auto-initializing with project ID:', projectId);
        
        // Extract other data attributes
        const config = {
          projectId: projectId,
          userId: script.getAttribute('data-user-id'),
          debug: script.getAttribute('data-debug') === 'true',
          apiEndpoint: script.getAttribute('data-api-endpoint')
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