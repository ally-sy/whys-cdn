(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    API_ENDPOINT: 'https://yyfmygwfyxeroqcyhoab.supabase.co/functions/v1/record-session', // Production endpoint
    BATCH_SIZE: 50,
    BATCH_TIMEOUT: 5000, // 5 seconds
    MAX_PAYLOAD_SIZE: 500 * 1024, // 500KB
    DEBUG: false // Production mode
  };

  // Global state
  let isInitialized = false;
  let projectId = null;
  let userId = null;
  let sessionId = null;
  let eventQueue = [];
  let batchTimer = null;
  let sessionData = null;

  // Utility functions
  function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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

  // Event capture functions
  function captureEvent(eventType, data = {}) {
    if (!isInitialized || !sessionId) return;

    const event = {
      sessionId: sessionId,
      eventType: eventType,
      timestamp: new Date().toISOString(),
      pageUrl: window.location.href,
      ...data
    };

    eventQueue.push(event);
    log('Event captured:', eventType, data);

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

    // Page unload - send remaining events
    window.addEventListener('beforeunload', function() {
      if (eventQueue.length > 0) {
        sendBatch(true); // Force send with beacon
      }
    });

    // Visibility change
    document.addEventListener('visibilitychange', function() {
      captureEvent('visibility', {
        metadata: { hidden: document.hidden }
      });
    });
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
      if (isInitialized) {
        log('Already initialized');
        return;
      }

      // Validate required config
      if (!config.projectId) {
        throw new Error('WhysRecorder: projectId is required');
      }

      projectId = config.projectId;
      userId = config.userId || null;
      sessionId = generateSessionId();

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
        userId: userId,
        anonymousUserId: getOrCreateAnonymousUserId(),
        pageUrl: window.location.href,
        userAgent: navigator.userAgent,
        screenResolution: `${screen.width}x${screen.height}`,
        viewportSize: `${window.innerWidth}x${window.innerHeight}`,
        deviceInfo: getDeviceInfo(),
        metadata: config.metadata || {}
      };

      // Setup event listeners
      setupEventListeners();
      
      isInitialized = true;
      log('Initialized with projectId:', projectId, 'sessionId:', sessionId);

      // Send initial session data
      captureEvent('session_start', {
        metadata: { initialized: true }
      });
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

    _getEventQueue: function() {
      return [...eventQueue];
    },

    _sendBatch: function() {
      sendBatch();
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
