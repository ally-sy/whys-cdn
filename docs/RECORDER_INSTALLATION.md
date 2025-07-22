# Whys Session Recorder Installation Guide

The Whys Session Recorder is a robust client-side script that captures user interactions and session data. This guide covers installation methods and best practices.

## Quick Start

### Method 1: Manual Initialization (Recommended)
```html
<script src="https://cdn.whyslab.io/recorder.js"></script>
<script>
  // Wait for recorder to load and initialize properly
  (function initRecorder() {
    if (typeof WhysRecorder === "undefined") {
      setTimeout(initRecorder, 100);
      return;
    }
    
    WhysRecorder.init({
      projectId: "your-project-id",  // Required: Get this from your project settings
      debug: false                   // Optional: Set to true for detailed logs
    }).catch(function(error) {
      console.error("[Whys Initialization Error]:", error);
    });
  })();
</script>
```

### Method 2: Google Tag Manager
1. Create a new Custom HTML tag
2. Add the following code:
```html
<script>
  // Create script element
  var script = document.createElement("script");
  script.src = "https://cdn.whyslab.io/recorder.js";
  
  // Initialize after script loads
  script.onload = function() {
    WhysRecorder.init({
      projectId: "your-project-id",
      debug: false
    }).catch(function(error) {
      console.error("[Whys Initialization Error]:", error);
    });
  };
  
  // Add script to page
  document.head.appendChild(script);
</script>
```
3. Set trigger to fire on All Pages
4. Test in GTM Preview mode before publishing

### Method 3: Auto-Init Script
```html
<script 
    src="https://cdn.whyslab.io/recorder.js" 
    data-project-id="your-project-id"
    data-debug="false">
</script>
```

## Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| projectId | string | Yes | - | Your project's unique identifier |
| debug | boolean | No | false | Enable detailed console logging |
| userId | string | No | null | Custom user identifier |
| batchSize | number | No | 50 | Events per batch (1-1000) |
| flushInterval | number | No | 5000 | Batch send interval (ms) |

## Advanced Features

### User Identification
```javascript
WhysRecorder.identify("user-123");  // Call after user logs in
```

### Custom Event Tracking
```javascript
WhysRecorder.track("custom_event", {
  category: "engagement",
  action: "feature_used",
  label: "dashboard_filter"
});
```

### Session Status
```javascript
const status = WhysRecorder._getSessionStatus();
console.log("Session active:", !status.sessionEnded);
```

## Best Practices

1. **Placement**: Add the recorder script in the `<head>` tag for optimal page load performance.

2. **Error Handling**: Always include error handling when initializing:
```javascript
WhysRecorder.init(config)
  .catch(function(error) {
    console.error("[Whys Error]:", error);
    // Optional: Send error to your monitoring system
  });
```

3. **Initialization Timing**: The manual initialization method is recommended as it ensures proper loading and initialization sequence.

4. **Debug Mode**: Enable debug mode temporarily when testing or troubleshooting:
```javascript
WhysRecorder.init({
  projectId: "your-project-id",
  debug: true  // Enable detailed logs
});
```

## Safety Features

The recorder includes several built-in safety mechanisms:

- Automatic retry with exponential backoff for network failures
- Circuit breaker to prevent excessive retries
- Memory protection with event queue limits
- Automatic session cleanup
- Safe data handling with validation
- Performance monitoring and rate limiting

## Troubleshooting

### Common Issues

1. **Initialization Failures**
   - Check if projectId is correct
   - Verify script is loaded (check network tab)
   - Enable debug mode to see detailed logs

2. **Missing Events**
   - Check console for rate limit warnings
   - Verify session is not ended
   - Ensure proper initialization

3. **Network Errors**
   - Check CORS settings
   - Verify API endpoint accessibility
   - Check browser console for specific errors

### Debug Mode

Enable debug mode to see detailed logs:
```javascript
WhysRecorder.init({
  projectId: "your-project-id",
  debug: true
});
```

### Health Check

Verify recorder status:
```javascript
console.log("Session:", WhysRecorder._getSessionId());
console.log("Status:", WhysRecorder._getSessionStatus());
console.log("Events:", WhysRecorder._getEventQueue());
```

## Support

For additional support:
- Email: support@whyslab.io
- Documentation: https://docs.whyslab.io
- Status Page: https://status.whyslab.io
