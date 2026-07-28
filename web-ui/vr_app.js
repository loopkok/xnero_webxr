// Wait for A-Frame scene to load

AFRAME.registerComponent('controller-updater', {
  init: function () {
    console.log("Controller updater component initialized.");

    // --- Force hand-tracking in XR session ---
    this._handTrackingRequested = false;
    if (navigator.xr && navigator.xr.requestSession) {
      const _origRequestSession = navigator.xr.requestSession.bind(navigator.xr);
      const self = this;
      navigator.xr.requestSession = async function(mode, init) {
        if (mode === 'immersive-vr' || mode === 'immersive-ar') {
          init = init || {};
          init.optionalFeatures = init.optionalFeatures || [];
          if (!init.optionalFeatures.includes('hand-tracking')) {
            init.optionalFeatures.push('hand-tracking');
            self._handTrackingRequested = true;
          }
          console.log('[HandTracking] Session features requested:', JSON.stringify(init.optionalFeatures));
        }
        const session = await _origRequestSession(mode, init);
        console.log('[HandTracking] Session created, enabledFeatures:',
          session.enabledFeatures ? Array.from(session.enabledFeatures) : 'N/A');
        return session;
      };
      console.log('[HandTracking] Patched navigator.xr.requestSession');
    }
    // --- End hand-tracking patch ---

    // Controllers are enabled

    this.leftHand = document.querySelector('#leftHand');
    this.rightHand = document.querySelector('#rightHand');
    this.leftHandInfoText = document.querySelector('#leftHandInfo');
    this.rightHandInfoText = document.querySelector('#rightHandInfo');
    
    // Add headset tracking
    this.headset = document.querySelector('#headset');
    this.headsetInfoText = document.querySelector('#headsetInfo');

    // --- WebSocket Setup ---
    this.websocket = null;
    this.leftGripDown = false;
    this.rightGripDown = false;
    this.leftTriggerDown = false;
    this.rightTriggerDown = false;

    // --- Status reporting ---
    this.lastStatusUpdate = 0;
    this.statusUpdateInterval = 5000; // 5 seconds

    // --- Relative rotation tracking ---
    this.leftGripInitialRotation = null;
    this.rightGripInitialRotation = null;
    this.leftRelativeRotation = { x: 0, y: 0, z: 0 };
    this.rightRelativeRotation = { x: 0, y: 0, z: 0 };

    // --- Quaternion-based Z-axis rotation tracking ---
    this.leftGripInitialQuaternion = null;
    this.rightGripInitialQuaternion = null;
    this.leftZAxisRotation = 0;
    this.rightZAxisRotation = 0;

    // --- Hand tracking support ---
    this.leftHandJoints = null;   // Raw joint data for left hand
    this.rightHandJoints = null;  // Raw joint data for right hand
    this.handTrackingSupported = false;  // Set to true when hand data is detected
    this._handRefSpace = null;           // 'local' reference space for hand joints
    this._handRefSpaceRequested = false;

    // --- WebXR → MediaPipe 21-landmark mapping ---
    // Maps WebXR joint names to MediaPipe landmark indices (0-20).
    // The 4 metacarpal joints (index/middle/ring/pinky-finger-metacarpal) are skipped.
    this.WEBXR_TO_MEDIAPIPE = [
        'wrist',                          // 0
        'thumb-metacarpal',               // 1  THUMB_CMC
        'thumb-phalanx-proximal',         // 2  THUMB_MCP
        'thumb-phalanx-distal',           // 3  THUMB_IP
        'thumb-tip',                      // 4  THUMB_TIP
        'index-finger-phalanx-proximal',  // 5  INDEX_FINGER_MCP
        'index-finger-phalanx-intermediate', // 6  INDEX_FINGER_PIP
        'index-finger-phalanx-distal',    // 7  INDEX_FINGER_DIP
        'index-finger-tip',               // 8  INDEX_FINGER_TIP
        'middle-finger-phalanx-proximal', // 9  MIDDLE_FINGER_MCP
        'middle-finger-phalanx-intermediate', // 10 MIDDLE_FINGER_PIP
        'middle-finger-phalanx-distal',   // 11 MIDDLE_FINGER_DIP
        'middle-finger-tip',              // 12 MIDDLE_FINGER_TIP
        'ring-finger-phalanx-proximal',   // 13 RING_FINGER_MCP
        'ring-finger-phalanx-intermediate', // 14 RING_FINGER_PIP
        'ring-finger-phalanx-distal',     // 15 RING_FINGER_DIP
        'ring-finger-tip',                // 16 RING_FINGER_TIP
        'pinky-finger-phalanx-proximal',  // 17 PINKY_MCP
        'pinky-finger-phalanx-intermediate', // 18 PINKY_PIP
        'pinky-finger-phalanx-distal',    // 19 PINKY_DIP
        'pinky-finger-tip'                // 20 PINKY_TIP
    ];

    this.convertToMediaPipe = function(jointsDict) {
        /** Convert WebXR 25-joint dict to MediaPipe 21-landmark array.
         *  Returns an array of 21 landmarks, each: {x, y, z}.
         *  Returns null if wrist (landmark 0) is missing.
         */
        if (!jointsDict || !jointsDict['wrist']) return null;
        var landmarks = [];
        for (var i = 0; i < this.WEBXR_TO_MEDIAPIPE.length; i++) {
            var jointName = this.WEBXR_TO_MEDIAPIPE[i];
            var joint = jointsDict[jointName];
            if (joint && joint.position) {
                landmarks.push({
                    x: joint.position.x,
                    y: joint.position.y,
                    z: joint.position.z
                });
            } else {
                // Joint missing — push zero placeholder to keep 21-length invariant
                landmarks.push({x: 0, y: 0, z: 0});
            }
        }
        return landmarks;
    };

    // --- Get hostname dynamically ---
    const serverHostname = window.location.hostname;
    const websocketPort = 8442; // Make sure this matches controller_server.py
    const websocketUrl = `wss://${serverHostname}:${websocketPort}`;
    console.log(`Attempting WebSocket connection to: ${websocketUrl}`);
    // !!! IMPORTANT: Replace 'YOUR_LAPTOP_IP' with the actual IP address of your laptop !!!
    // const websocketUrl = 'ws://YOUR_LAPTOP_IP:8442';
    try {
      this.websocket = new WebSocket(websocketUrl);
      this.websocket.onopen = (event) => {
        console.log(`WebSocket connected to ${websocketUrl}`);
        this.reportVRStatus(true);
      };
      this.websocket.onerror = (event) => {
        // More detailed error logging
        console.error(`WebSocket Error: Event type: ${event.type}`, event);
        this.reportVRStatus(false);
      };
      this.websocket.onclose = (event) => {
        console.log(`WebSocket disconnected from ${websocketUrl}. Clean close: ${event.wasClean}, Code: ${event.code}, Reason: '${event.reason}'`);
        // Attempt to log specific error if available (might be limited by browser security)
        if (!event.wasClean) {
          console.error('WebSocket closed unexpectedly.');
        }
        this.websocket = null; // Clear the reference
        this.reportVRStatus(false);
      };
      this.websocket.onmessage = (event) => {
        console.log(`WebSocket message received: ${event.data}`); // Log any messages from server
      };
    } catch (error) {
        console.error(`Failed to create WebSocket connection to ${websocketUrl}:`, error);
        this.reportVRStatus(false);
    }
    // --- End WebSocket Setup ---

    // --- VR Status Reporting Function ---
    this.reportVRStatus = (connected) => {
      // Update global status if available (for desktop interface)
      if (typeof updateStatus === 'function') {
        updateStatus({ vrConnected: connected });
      }
      
      // Also try to notify parent window if in iframe
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: 'vr_status',
            connected: connected
          }, '*');
        }
      } catch (e) {
        // Ignore cross-origin errors
      }
    };

    if (!this.leftHand || !this.rightHand || !this.leftHandInfoText || !this.rightHandInfoText) {
      console.error("Controller or text entities not found!");
      // Check which specific elements are missing
      if (!this.leftHand) console.error("Left hand entity not found");
      if (!this.rightHand) console.error("Right hand entity not found");
      if (!this.leftHandInfoText) console.error("Left hand info text not found");
      if (!this.rightHandInfoText) console.error("Right hand info text not found");
      return;
    }

    // Apply initial rotation to combined text elements
    const textRotation = '-90 0 0'; // Rotate -90 degrees around X-axis
    if (this.leftHandInfoText) this.leftHandInfoText.setAttribute('rotation', textRotation);
    if (this.rightHandInfoText) this.rightHandInfoText.setAttribute('rotation', textRotation);

    // --- Create axis indicators ---
    this.createAxisIndicators();

    // --- Create hand tracking visualizers ---
    this.createHandVisualizers();

    // --- Helper function to send grip release message ---
    this.sendGripRelease = (hand) => {
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        const releaseMessage = {
          hand: hand,
          gripReleased: true
        };
        this.websocket.send(JSON.stringify(releaseMessage));
        console.log(`Sent grip release for ${hand} hand`);
      }
    };

    // --- Helper function to send trigger release message ---
    this.sendTriggerRelease = (hand) => {
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        const releaseMessage = {
          hand: hand,
          triggerReleased: true
        };
        this.websocket.send(JSON.stringify(releaseMessage));
        console.log(`Sent trigger release for ${hand} hand`);
      }
    };

    // --- Helper function to calculate relative rotation ---
    this.calculateRelativeRotation = (currentRotation, initialRotation) => {
      return {
        x: currentRotation.x - initialRotation.x,
        y: currentRotation.y - initialRotation.y,
        z: currentRotation.z - initialRotation.z
      };
    };

    // --- Helper function to calculate Z-axis rotation from quaternions ---
    this.calculateZAxisRotation = (currentQuaternion, initialQuaternion) => {
      // Calculate relative quaternion (from initial to current)
      const relativeQuat = new THREE.Quaternion();
      relativeQuat.multiplyQuaternions(currentQuaternion, initialQuaternion.clone().invert());
      
      // Get the controller's current forward direction (local Z-axis in world space)
      const forwardDirection = new THREE.Vector3(0, 0, 1);
      forwardDirection.applyQuaternion(currentQuaternion);
      
      // Convert relative quaternion to axis-angle representation
      const angle = 2 * Math.acos(Math.abs(relativeQuat.w));
      
      // Handle case where there's no rotation (avoid division by zero)
      if (angle < 0.0001) {
        return 0;
      }
      
      // Get the rotation axis
      const sinHalfAngle = Math.sqrt(1 - relativeQuat.w * relativeQuat.w);
      const rotationAxis = new THREE.Vector3(
        relativeQuat.x / sinHalfAngle,
        relativeQuat.y / sinHalfAngle,
        relativeQuat.z / sinHalfAngle
      );
      
      // Project the rotation axis onto the forward direction to get the component
      // of rotation around the forward axis
      const projectedComponent = rotationAxis.dot(forwardDirection);
      
      // The rotation around the forward axis is the angle times the projection
      const forwardRotation = angle * projectedComponent;
      
      // Convert to degrees and handle the sign properly
      let degrees = THREE.MathUtils.radToDeg(forwardRotation);
      
      // Normalize to -180 to +180 range to avoid sudden jumps
      while (degrees > 180) degrees -= 360;
      while (degrees < -180) degrees += 360;
      
      return degrees;
    };

    // --- Modify Event Listeners ---
    this.leftHand.addEventListener('triggerdown', (evt) => {
        console.log('Left Trigger Pressed');
        this.leftTriggerDown = true;
    });
    this.leftHand.addEventListener('triggerup', (evt) => {
        console.log('Left Trigger Released');
        this.leftTriggerDown = false;
        this.sendTriggerRelease('left'); // Send trigger release message
    });
    this.leftHand.addEventListener('gripdown', (evt) => {
        console.log('Left Grip Pressed');
        this.leftGripDown = true; // Set grip state
        
        // Store initial rotation for relative tracking
        if (this.leftHand.object3D.visible) {
          const leftRotEuler = this.leftHand.object3D.rotation;
          this.leftGripInitialRotation = {
            x: THREE.MathUtils.radToDeg(leftRotEuler.x),
            y: THREE.MathUtils.radToDeg(leftRotEuler.y),
            z: THREE.MathUtils.radToDeg(leftRotEuler.z)
          };
          
          // Store initial quaternion for Z-axis rotation tracking
          this.leftGripInitialQuaternion = this.leftHand.object3D.quaternion.clone();
          
          console.log('Left grip initial rotation:', this.leftGripInitialRotation);
          console.log('Left grip initial quaternion:', this.leftGripInitialQuaternion);
        }
    });
    this.leftHand.addEventListener('gripup', (evt) => { // Add gripup listener
        console.log('Left Grip Released');
        this.leftGripDown = false; // Reset grip state
        this.leftGripInitialRotation = null; // Reset initial rotation
        this.leftGripInitialQuaternion = null; // Reset initial quaternion
        this.leftRelativeRotation = { x: 0, y: 0, z: 0 }; // Reset relative rotation
        this.leftZAxisRotation = 0; // Reset Z-axis rotation
        this.sendGripRelease('left'); // Send grip release message
    });

    this.rightHand.addEventListener('triggerdown', (evt) => {
        console.log('Right Trigger Pressed');
        this.rightTriggerDown = true;
    });
    this.rightHand.addEventListener('triggerup', (evt) => {
        console.log('Right Trigger Released');
        this.rightTriggerDown = false;
        this.sendTriggerRelease('right'); // Send trigger release message
    });
    this.rightHand.addEventListener('gripdown', (evt) => {
        console.log('Right Grip Pressed');
        this.rightGripDown = true; // Set grip state
        
        // Store initial rotation for relative tracking
        if (this.rightHand.object3D.visible) {
          const rightRotEuler = this.rightHand.object3D.rotation;
          this.rightGripInitialRotation = {
            x: THREE.MathUtils.radToDeg(rightRotEuler.x),
            y: THREE.MathUtils.radToDeg(rightRotEuler.y),
            z: THREE.MathUtils.radToDeg(rightRotEuler.z)
          };
          
          // Store initial quaternion for Z-axis rotation tracking
          this.rightGripInitialQuaternion = this.rightHand.object3D.quaternion.clone();
          
          console.log('Right grip initial rotation:', this.rightGripInitialRotation);
          console.log('Right grip initial quaternion:', this.rightGripInitialQuaternion);
        }
    });
    this.rightHand.addEventListener('gripup', (evt) => { // Add gripup listener
        console.log('Right Grip Released');
        this.rightGripDown = false; // Reset grip state
        this.rightGripInitialRotation = null; // Reset initial rotation
        this.rightGripInitialQuaternion = null; // Reset initial quaternion
        this.rightRelativeRotation = { x: 0, y: 0, z: 0 }; // Reset relative rotation
        this.rightZAxisRotation = 0; // Reset Z-axis rotation
        this.sendGripRelease('right'); // Send grip release message
    });
    // --- End Modify Event Listeners ---

  },

  createAxisIndicators: function() {
    // Create XYZ axis indicators for both controllers
    
    // Left Controller Axes
    // X-axis (Red)
    const leftXAxis = document.createElement('a-cylinder');
    leftXAxis.setAttribute('id', 'leftXAxis');
    leftXAxis.setAttribute('height', '0.08');
    leftXAxis.setAttribute('radius', '0.003');
    leftXAxis.setAttribute('color', '#ff0000'); // Red for X
    leftXAxis.setAttribute('position', '0.04 0 0');
    leftXAxis.setAttribute('rotation', '0 0 90'); // Rotate to point along X-axis
    this.leftHand.appendChild(leftXAxis);

    const leftXTip = document.createElement('a-cone');
    leftXTip.setAttribute('height', '0.015');
    leftXTip.setAttribute('radius-bottom', '0.008');
    leftXTip.setAttribute('radius-top', '0');
    leftXTip.setAttribute('color', '#ff0000');
    leftXTip.setAttribute('position', '0.055 0 0');
    leftXTip.setAttribute('rotation', '0 0 90');
    this.leftHand.appendChild(leftXTip);

    // Y-axis (Green) - Up
    const leftYAxis = document.createElement('a-cylinder');
    leftYAxis.setAttribute('id', 'leftYAxis');
    leftYAxis.setAttribute('height', '0.08');
    leftYAxis.setAttribute('radius', '0.003');
    leftYAxis.setAttribute('color', '#00ff00'); // Green for Y
    leftYAxis.setAttribute('position', '0 0.04 0');
    leftYAxis.setAttribute('rotation', '0 0 0'); // Default up orientation
    this.leftHand.appendChild(leftYAxis);

    const leftYTip = document.createElement('a-cone');
    leftYTip.setAttribute('height', '0.015');
    leftYTip.setAttribute('radius-bottom', '0.008');
    leftYTip.setAttribute('radius-top', '0');
    leftYTip.setAttribute('color', '#00ff00');
    leftYTip.setAttribute('position', '0 0.055 0');
    this.leftHand.appendChild(leftYTip);

    // Z-axis (Blue) - Forward
    const leftZAxis = document.createElement('a-cylinder');
    leftZAxis.setAttribute('id', 'leftZAxis');
    leftZAxis.setAttribute('height', '0.08');
    leftZAxis.setAttribute('radius', '0.003');
    leftZAxis.setAttribute('color', '#0000ff'); // Blue for Z
    leftZAxis.setAttribute('position', '0 0 0.04');
    leftZAxis.setAttribute('rotation', '90 0 0'); // Rotate to point along Z-axis
    this.leftHand.appendChild(leftZAxis);

    const leftZTip = document.createElement('a-cone');
    leftZTip.setAttribute('height', '0.015');
    leftZTip.setAttribute('radius-bottom', '0.008');
    leftZTip.setAttribute('radius-top', '0');
    leftZTip.setAttribute('color', '#0000ff');
    leftZTip.setAttribute('position', '0 0 0.055');
    leftZTip.setAttribute('rotation', '90 0 0');
    this.leftHand.appendChild(leftZTip);

    // Right Controller Axes
    // X-axis (Red)
    const rightXAxis = document.createElement('a-cylinder');
    rightXAxis.setAttribute('id', 'rightXAxis');
    rightXAxis.setAttribute('height', '0.08');
    rightXAxis.setAttribute('radius', '0.003');
    rightXAxis.setAttribute('color', '#ff0000'); // Red for X
    rightXAxis.setAttribute('position', '0.04 0 0');
    rightXAxis.setAttribute('rotation', '0 0 90'); // Rotate to point along X-axis
    this.rightHand.appendChild(rightXAxis);

    const rightXTip = document.createElement('a-cone');
    rightXTip.setAttribute('height', '0.015');
    rightXTip.setAttribute('radius-bottom', '0.008');
    rightXTip.setAttribute('radius-top', '0');
    rightXTip.setAttribute('color', '#ff0000');
    rightXTip.setAttribute('position', '0.055 0 0');
    rightXTip.setAttribute('rotation', '0 0 90');
    this.rightHand.appendChild(rightXTip);

    // Y-axis (Green) - Up
    const rightYAxis = document.createElement('a-cylinder');
    rightYAxis.setAttribute('id', 'rightYAxis');
    rightYAxis.setAttribute('height', '0.08');
    rightYAxis.setAttribute('radius', '0.003');
    rightYAxis.setAttribute('color', '#00ff00'); // Green for Y
    rightYAxis.setAttribute('position', '0 0.04 0');
    rightYAxis.setAttribute('rotation', '0 0 0'); // Default up orientation
    this.rightHand.appendChild(rightYAxis);

    const rightYTip = document.createElement('a-cone');
    rightYTip.setAttribute('height', '0.015');
    rightYTip.setAttribute('radius-bottom', '0.008');
    rightYTip.setAttribute('radius-top', '0');
    rightYTip.setAttribute('color', '#00ff00');
    rightYTip.setAttribute('position', '0 0.055 0');
    this.rightHand.appendChild(rightYTip);

    // Z-axis (Blue) - Forward
    const rightZAxis = document.createElement('a-cylinder');
    rightZAxis.setAttribute('id', 'rightZAxis');
    rightZAxis.setAttribute('height', '0.08');
    rightZAxis.setAttribute('radius', '0.003');
    rightZAxis.setAttribute('color', '#0000ff'); // Blue for Z
    rightZAxis.setAttribute('position', '0 0 0.04');
    rightZAxis.setAttribute('rotation', '90 0 0'); // Rotate to point along Z-axis
    this.rightHand.appendChild(rightZAxis);

    const rightZTip = document.createElement('a-cone');
    rightZTip.setAttribute('height', '0.015');
    rightZTip.setAttribute('radius-bottom', '0.008');
    rightZTip.setAttribute('radius-top', '0');
    rightZTip.setAttribute('color', '#0000ff');
    rightZTip.setAttribute('position', '0 0 0.055');
    rightZTip.setAttribute('rotation', '90 0 0');
    this.rightHand.appendChild(rightZTip);

    console.log('XYZ axis indicators created for both controllers (RGB for XYZ)');
  },

  // --- Hand tracking visualizers (static HTML entities, updated by position) ---
  createHandVisualizers: function () {
    // References to entities defined in index.html
    this.leftHandMarker  = document.getElementById('leftHandMarker');
    this.rightHandMarker = document.getElementById('rightHandMarker');
    this.leftHandMarkerText  = document.getElementById('leftHandMarkerText');
    this.rightHandMarkerText = document.getElementById('rightHandMarkerText');
    this.handStatusText = document.getElementById('handStatusText');

    // Set initial default positions (in front of user)
    if (this.leftHandMarker)  this.leftHandMarker.setAttribute('position', '-0.15 1.3 -0.4');
    if (this.rightHandMarker) this.rightHandMarker.setAttribute('position', '0.15 1.3 -0.4');

    // Create 21-joint micro-axis indicators per hand (RGB cylinders, no sphere, no text)
    this._createJointAxes('left');
    this._createJointAxes('right');

    console.log('Hand tracking visualizers ready (static HTML entities)');
  },

  // Create 21 tiny axis-only indicators for each hand joint
  _createJointAxes: function (side) {
    var scene = this.el.sceneEl;
    var arr = [];
    for (var i = 0; i < 21; i++) {
      var c = document.createElement('a-entity');
      c.setAttribute('visible', 'false');
      // micro RGB axes
      ['red','green','blue'].forEach(function(col, idx) {
        var cyl = document.createElement('a-cylinder');
        cyl.setAttribute('height', '0.015');
        cyl.setAttribute('radius', '0.0006');
        cyl.setAttribute('color', col);
        if (idx === 0) { cyl.setAttribute('position', '0.0075 0 0'); cyl.setAttribute('rotation', '0 0 90'); }
        if (idx === 1) { cyl.setAttribute('position', '0 0.0075 0'); }
        if (idx === 2) { cyl.setAttribute('position', '0 0 0.0075'); cyl.setAttribute('rotation', '90 0 0'); }
        c.appendChild(cyl);
      });
      scene.appendChild(c);
      arr.push(c);
    }
    if (side === 'left') this.leftJointAxes = arr;
    else this.rightJointAxes = arr;
  },

  // Update 21 joint axis positions from scene-space data
  _updateJointAxes: function (side, jointsScene) {
    var arr = side === 'left' ? this.leftJointAxes : this.rightJointAxes;
    if (!arr) return;
    for (var i = 0; i < 21; i++) {
      var name = this.WEBXR_TO_MEDIAPIPE[i];
      var sp = jointsScene[name];
      var ent = arr[i];
      if (sp && ent) {
        ent.setAttribute('visible', 'true');
        ent.setAttribute('position', sp.x.toFixed(4) + ' ' + sp.y.toFixed(4) + ' ' + sp.z.toFixed(4));
      } else if (ent) {
        ent.setAttribute('visible', 'false');
      }
    }
  },

  _updateHandVis: function (marker, markerText, wristJoint, jointCount, side) {
    if (!marker || !markerText || !wristJoint) return;
    var p = wristJoint.position;
    var q = wristJoint.quaternion;
    if (!p || typeof p.x !== 'number' || isNaN(p.x)) return;

    // Position is already in scene reference space — use directly.
    marker.setAttribute('position', p.x.toFixed(3) + ' ' + p.y.toFixed(3) + ' ' + p.z.toFixed(3));
    if (q && typeof q.x === 'number' && !isNaN(q.x)) {
      marker.setAttribute('rotation', {
        x: THREE.MathUtils.radToDeg(Math.atan2(2*(q.w*q.x + q.y*q.z), 1-2*(q.x*q.x + q.y*q.y))),
        y: THREE.MathUtils.radToDeg(Math.asin(2*(q.w*q.y - q.z*q.x))),
        z: THREE.MathUtils.radToDeg(Math.atan2(2*(q.w*q.z + q.x*q.y), 1-2*(q.y*q.y + q.z*q.z)))
      });
    }
    markerText.setAttribute('position', '0 0.035 0');
    markerText.setAttribute('value',
      'Hand ' + side + '\n' +
      'Pos: ' + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ' ' + p.z.toFixed(2) + '\n' +
      'Joints: ' + jointCount);
  },

  tick: function () {
    // Update controller text if controllers are visible
    if (!this.leftHand || !this.rightHand) return; // Added safety check

    // Force both controller entities visible so axes + text always render,
    // even when Quest browser hasn't reported a controller yet (e.g. one
    // controller asleep, or hand-tracking active without physical controllers).
    if (this.leftHand.object3D) this.leftHand.object3D.visible = true;
    if (this.rightHand.object3D) this.rightHand.object3D.visible = true;

    // --- BEGIN DETAILED LOGGING ---
    if (this.leftHand.object3D) {
      // console.log(`Left Hand Raw - Visible: ${this.leftHand.object3D.visible}, Pos: ${this.leftHand.object3D.position.x.toFixed(2)},${this.leftHand.object3D.position.y.toFixed(2)},${this.leftHand.object3D.position.z.toFixed(2)}`);
    }
    if (this.rightHand.object3D) {
      // console.log(`Right Hand Raw - Visible: ${this.rightHand.object3D.visible}, Pos: ${this.rightHand.object3D.position.x.toFixed(2)},${this.rightHand.object3D.position.y.toFixed(2)},${this.rightHand.object3D.position.z.toFixed(2)}`);
    }
    // --- END DETAILED LOGGING ---

    // Collect data from both controllers
    const leftController = {
        hand: 'left',
        position: null,
        rotation: null,
        gripActive: false,
        trigger: 0
    };
    
    const rightController = {
        hand: 'right',
        position: null,
        rotation: null,
        gripActive: false,
        trigger: 0
    };
    
    // Collect headset data
    const headset = {
        position: null,
        rotation: null,
        quaternion: null
    };

    // Update Left Hand Text & Collect Data
    // 移除object3D.visible检查，确保即使控制器不可见也能收集数据
    if (this.leftHand && this.leftHand.object3D) {
        const leftPos = this.leftHand.object3D.position;
        const leftRotEuler = this.leftHand.object3D.rotation; // Euler angles in radians
        // Convert to degrees without offset
        const leftRotX = THREE.MathUtils.radToDeg(leftRotEuler.x);
        const leftRotY = THREE.MathUtils.radToDeg(leftRotEuler.y);
        const leftRotZ = THREE.MathUtils.radToDeg(leftRotEuler.z);

        // 添加调试信息
        console.log(`Left Hand - Visible: ${this.leftHand.object3D.visible}, Pos: ${leftPos.x.toFixed(2)},${leftPos.y.toFixed(2)},${leftPos.z.toFixed(2)}`);

        // Calculate relative rotation if grip is held
        if (this.leftGripDown && this.leftGripInitialRotation) {
          this.leftRelativeRotation = this.calculateRelativeRotation(
            { x: leftRotX, y: leftRotY, z: leftRotZ },
            this.leftGripInitialRotation
          );
          
          // Calculate Z-axis rotation using quaternions
          if (this.leftGripInitialQuaternion) {
            this.leftZAxisRotation = this.calculateZAxisRotation(
              this.leftHand.object3D.quaternion,
              this.leftGripInitialQuaternion
            );
          }
          
          console.log('Left relative rotation:', this.leftRelativeRotation);
          console.log('Left Z-axis rotation:', this.leftZAxisRotation.toFixed(1), 'degrees');
        }

        // Create display text including relative rotation when grip is held
        let combinedLeftText = `Pos: ${leftPos.x.toFixed(2)} ${leftPos.y.toFixed(2)} ${leftPos.z.toFixed(2)}\\nRot: ${leftRotX.toFixed(0)} ${leftRotY.toFixed(0)} ${leftRotZ.toFixed(0)}`;
        if (this.leftGripDown && this.leftGripInitialRotation) {
          combinedLeftText += `\\nZ-Rot: ${this.leftZAxisRotation.toFixed(1)}°`;
        }

        if (this.leftHandInfoText) {
            this.leftHandInfoText.setAttribute('value', combinedLeftText);
        }

        // Collect left controller data
        leftController.position = { x: leftPos.x, y: leftPos.y, z: leftPos.z };
        leftController.rotation = { x: leftRotX, y: leftRotY, z: leftRotZ };
        leftController.quaternion = { 
          x: this.leftHand.object3D.quaternion.x, 
          y: this.leftHand.object3D.quaternion.y, 
          z: this.leftHand.object3D.quaternion.z, 
          w: this.leftHand.object3D.quaternion.w 
        };
        leftController.trigger = this.leftTriggerDown ? 1 : 0;
        leftController.gripActive = this.leftGripDown;
        
        // 采集左手柄的摇杆和按钮信息
        if (this.leftHand && this.leftHand.components && this.leftHand.components['tracked-controls']) {
            const leftGamepad = this.leftHand.components['tracked-controls'].controller?.gamepad;
            if (leftGamepad) {
                // 摇杆
                leftController.thumbstick = {
                    x: leftGamepad.axes[2] || 0,
                    y: leftGamepad.axes[3] || 0
                };
                // 侧边按钮
                leftController.buttons = {
                    a: !!leftGamepad.buttons[3]?.pressed,
                    b: !!leftGamepad.buttons[4]?.pressed,
                    squeeze: !!leftGamepad.buttons[1]?.pressed,
                    thumbstick: !!leftGamepad.buttons[2]?.pressed,
                    menu: !!leftGamepad.buttons[6]?.pressed
                };
            }
        }
    } else {
        console.log('Left hand object not available');
    }

    // Update Right Hand Text & Collect Data
    // 移除object3D.visible检查，确保即使控制器不可见也能收集数据
    if (this.rightHand && this.rightHand.object3D) {
        const rightPos = this.rightHand.object3D.position;
        const rightRotEuler = this.rightHand.object3D.rotation; // Euler angles in radians
        // Convert to degrees without offset
        const rightRotX = THREE.MathUtils.radToDeg(rightRotEuler.x);
        const rightRotY = THREE.MathUtils.radToDeg(rightRotEuler.y);
        const rightRotZ = THREE.MathUtils.radToDeg(rightRotEuler.z);

        // 添加调试信息
        console.log(`Right Hand - Visible: ${this.rightHand.object3D.visible}, Pos: ${rightPos.x.toFixed(2)},${rightPos.y.toFixed(2)},${rightPos.z.toFixed(2)}`);

        // Calculate relative rotation if grip is held
        if (this.rightGripDown && this.rightGripInitialRotation) {
          this.rightRelativeRotation = this.calculateRelativeRotation(
            { x: rightRotX, y: rightRotY, z: rightRotZ },
            this.rightGripInitialRotation
          );
          
          // Calculate Z-axis rotation using quaternions
          if (this.rightGripInitialQuaternion) {
            this.rightZAxisRotation = this.calculateZAxisRotation(
              this.rightHand.object3D.quaternion,
              this.rightGripInitialQuaternion
            );
          }
          
          console.log('Right relative rotation:', this.rightRelativeRotation);
          console.log('Right Z-axis rotation:', this.rightZAxisRotation.toFixed(1), 'degrees');
        }

        // Create display text including relative rotation when grip is held
        let combinedRightText = `Pos: ${rightPos.x.toFixed(2)} ${rightPos.y.toFixed(2)} ${rightPos.z.toFixed(2)}\\nRot: ${rightRotX.toFixed(0)} ${rightRotY.toFixed(0)} ${rightRotZ.toFixed(0)}`;
        if (this.rightGripDown && this.rightGripInitialRotation) {
          combinedRightText += `\\nZ-Rot: ${this.rightZAxisRotation.toFixed(1)}°`;
        }

        if (this.rightHandInfoText) {
            this.rightHandInfoText.setAttribute('value', combinedRightText);
        }

        // Collect right controller data
        rightController.position = { x: rightPos.x, y: rightPos.y, z: rightPos.z };
        rightController.rotation = { x: rightRotX, y: rightRotY, z: rightRotZ };
        rightController.quaternion = { 
          x: this.rightHand.object3D.quaternion.x, 
          y: this.rightHand.object3D.quaternion.y, 
          z: this.rightHand.object3D.quaternion.z, 
          w: this.rightHand.object3D.quaternion.w 
        };
        rightController.trigger = this.rightTriggerDown ? 1 : 0;
        rightController.gripActive = this.rightGripDown;
        
        // 采集右手柄的摇杆和按钮信息
        if (this.rightHand && this.rightHand.components && this.rightHand.components['tracked-controls']) {
            const rightGamepad = this.rightHand.components['tracked-controls'].controller?.gamepad;
            if (rightGamepad) {
                // 摇杆
                rightController.thumbstick = {
                    x: rightGamepad.axes[2] || 0,
                    y: rightGamepad.axes[3] || 0
                };
                // 侧边按钮
                rightController.buttons = {
                    a: !!rightGamepad.buttons[3]?.pressed,
                    b: !!rightGamepad.buttons[4]?.pressed,
                    squeeze: !!rightGamepad.buttons[1]?.pressed,
                    thumbstick: !!rightGamepad.buttons[2]?.pressed,
                    menu: !!rightGamepad.buttons[6]?.pressed
                };
            }
        }
    } else {
        console.log('Right hand object not available');
    }

    // Collect headset data
    if (this.headset && this.headset.object3D) {
        const headsetPos = this.headset.object3D.position;
        const headsetRotEuler = this.headset.object3D.rotation;
        const headsetRotX = THREE.MathUtils.radToDeg(headsetRotEuler.x);
        const headsetRotY = THREE.MathUtils.radToDeg(headsetRotEuler.y);
        const headsetRotZ = THREE.MathUtils.radToDeg(headsetRotEuler.z);

        // Update headset info text
        const headsetText = `Pos: ${headsetPos.x.toFixed(2)} ${headsetPos.y.toFixed(2)} ${headsetPos.z.toFixed(2)}\nRot: ${headsetRotX.toFixed(0)} ${headsetRotY.toFixed(0)} ${headsetRotZ.toFixed(0)}`;
        if (this.headsetInfoText) {
            this.headsetInfoText.setAttribute('value', headsetText);
        }

        // Collect headset data
        headset.position = { x: headsetPos.x, y: headsetPos.y, z: headsetPos.z };
        headset.rotation = { x: headsetRotX, y: headsetRotY, z: headsetRotZ };
        headset.quaternion = { 
          x: this.headset.object3D.quaternion.x, 
          y: this.headset.object3D.quaternion.y, 
          z: this.headset.object3D.quaternion.z, 
          w: this.headset.object3D.quaternion.w 
        };
        
        console.log(`Headset - Pos: ${headsetPos.x.toFixed(2)},${headsetPos.y.toFixed(2)},${headsetPos.z.toFixed(2)}`);
    } else {
        console.log('Headset object not available');
    }

    // --- Hand Tracking Data Collection (WebXR Hand API) ---
    let leftHandData = null;
    let rightHandData = null;
    // Track which hands were seen this frame (reset visualizers for unseen)
    this._handSeenLeft = false;
    this._handSeenRight = false;
    // Periodic debug: report hand tracking status every 5s
    if (!this._lastHandDebugTime) this._lastHandDebugTime = 0;
    try {
        const renderer = this.el.sceneEl.renderer;
        if (renderer && renderer.xr) {
            const xrFrame = renderer.xr.getFrame();
            let refSpace = renderer.xr.getReferenceSpace();
            const session = renderer.xr.getSession();
            // Quest hand tracking may need 'local' reference space instead of 'local-floor'
            if (session && !this._handRefSpace && !this._handRefSpaceRequested) {
                this._handRefSpaceRequested = true;
                session.requestReferenceSpace('local').then(function(rs) {
                    this._handRefSpace = rs;
                    console.log('[HandTracking] Got local reference space');
                }.bind(this)).catch(function(e) {
                    console.log('[HandTracking] local refSpace failed:', e.message);
                });
            }
            if (this._handRefSpace) refSpace = this._handRefSpace;
            const now = Date.now();
            if (now - this._lastHandDebugTime > 5000) {
                this._lastHandDebugTime = now;
                // Build on-screen status
                var hasHand = false, hasCtrl = false;
                var srcDetails = [];
                if (session && session.inputSources.length > 0) {
                    for (const src of session.inputSources) {
                        if (src.hand) hasHand = true;
                        if (src.gamepad) hasCtrl = true;
                        srcDetails.push(src.handedness + ':' + (src.hand ? 'hand' : src.gamepad ? 'ctrl' : '?'));
                    }
                }
                var statusLines = [
                  'session=' + !!session + ' frame=' + !!xrFrame + ' ref=' + !!refSpace,
                  'inputSources=' + (session ? session.inputSources.length : 0) + ' [' + srcDetails.join(', ') + ']',
                  'hands=' + hasHand + ' controllers=' + hasCtrl,
                  'handTrkReq=' + this._handTrackingRequested + ' refLocal=' + !!this._handRefSpace
                ];
                if (this.handStatusText) {
                  this.handStatusText.setAttribute('value', 'Hand Tracking\n' + statusLines.join('\n'));
                }
                console.log('[HandTracking] ' + statusLines.join(' | '));
            }
            // Reset extraction counters each tick
            this._handEntriesOk = false;
            this._handJointCount = 0;
            this._handPoseHits = 0;
            this._handPoseMisses = 0;
            if (session && xrFrame && refSpace) {
                var sceneRefSpace = renderer.xr.getReferenceSpace(); // scene coords
                for (const inputSource of session.inputSources) {
                    if (inputSource.hand) {
                        const h = inputSource.hand;
                        const joints = {};
                        let wristJS = null;
                        let jointCount = 0, poseHits = 0, poseMisses = 0;
                        let extractErr = null;
                        var jointsScene = {};  // scene-space positions for all joints (for 3D viz)
                        try {
                            // entries() confirmed working in dump
                            if (typeof h.entries === 'function') {
                                for (const pair of h.entries()) {
                                    if (!pair || pair.length < 2) continue;
                                    const name = pair[0];
                                    const js = pair[1];
                                    if (!name || !js) continue;
                                    if (name === 'wrist') wristJS = js;
                                    jointCount++;
                                    const pose = xrFrame.getJointPose(js, refSpace);
                                    // WebXR spec: pose.transform is the standard API,
                                    // pose.position/orientation are deprecated and may be null
                                    const hasPos = pose && ((pose.position && pose.orientation) || (pose.transform && pose.transform.position));
                                    if (hasPos) {
                                        poseHits++;
                                        const p = pose.position || (pose.transform && pose.transform.position);
                                        const o = pose.orientation || (pose.transform && pose.transform.orientation);
                                        joints[name] = {
                                            position: { x: p.x, y: p.y, z: p.z },
                                            quaternion: { x: o.x, y: o.y, z: o.z, w: o.w },
                                            radius: js.radius || 0.005
                                        };
                                    } else { poseMisses++; }
                                    // Also get scene-space position for 3D marker rendering
                                    if (sceneRefSpace) {
                                        try {
                                            var sp = xrFrame.getJointPose(js, sceneRefSpace);
                                            if (sp) {
                                                var spp = sp.position || (sp.transform && sp.transform.position);
                                                if (spp) jointsScene[name] = { x: spp.x, y: spp.y, z: spp.z };
                                            }
                                        } catch(e) {}
                                    }
                                }
                            }
                        } catch(e) { extractErr = e.message; }

                        // Get wrist pose in SCENE reference space for correct 3D marker placement
                        var wristJointScene = null;
                        if (wristJS && sceneRefSpace) {
                            try {
                                var spose = xrFrame.getJointPose(wristJS, sceneRefSpace);
                                if (spose) {
                                    var spp = spose.position || (spose.transform && spose.transform.position);
                                    var spq = spose.orientation || (spose.transform && spose.transform.orientation);
                                    if (spp) {
                                        wristJointScene = {
                                            position: { x: spp.x, y: spp.y, z: spp.z },
                                            quaternion: spq ? { x: spq.x, y: spq.y, z: spq.z, w: spq.w } : null
                                        };
                                    }
                                }
                            } catch(e) {}
                        }
                        this._handEntriesOk  = (jointCount > 0);
                        this._handJointCount = jointCount;
                        this._handPoseHits   = poseHits;
                        this._handPoseMisses = poseMisses;
                        this._handExtractErr = extractErr;
                        this._loggedHandSize = true;
                        if (Object.keys(joints).length > 0) {
                            const handKey = inputSource.handedness === 'right' ? 'right' : 'left';
                            const wristJoint = joints['wrist'] || null;
                            const mpLandmarks = this.convertToMediaPipe(joints);
                            // Only send hand data if we have valid landmarks
                            if (mpLandmarks && wristJoint) {
                                const handObj = {
                                    hand: handKey,
                                    landmarks: mpLandmarks,           // MediaPipe 21-point array
                                    wrist: wristJoint                // keep wrist for server-side IK control
                                };
                                // Use scene-space wrist for 3D marker (no manual conversion)
                                var visWrist = wristJointScene || wristJoint;
                                if (handKey === 'left') {
                                    leftHandData = handObj;
                                    this.leftHandJoints = joints;
                                    this._handSeenLeft = true;
                                    this._updateHandVis(this.leftHandMarker, this.leftHandMarkerText,
                                        visWrist, Object.keys(joints).length, 'L');
                                    this._updateJointAxes('left', jointsScene);
                                } else {
                                    rightHandData = handObj;
                                    this.rightHandJoints = joints;
                                    this._handSeenRight = true;
                                    this._updateHandVis(this.rightHandMarker, this.rightHandMarkerText,
                                        visWrist, Object.keys(joints).length, 'R');
                                    this._updateJointAxes('right', jointsScene);
                                }
                                if (!this.handTrackingSupported) {
                                    this.handTrackingSupported = true;
                                    console.log('Hand tracking detected! Landmarks:', mpLandmarks.length);
                                }
                            }
                        }
                    }
                }
            }
        }
    } catch (e) {
        // Hand tracking may fail silently if not supported by device
    }

    // Reset visualizers for hands that weren't seen this frame
    if (!this._handSeenLeft) {
      if (this.leftHandMarkerText) this.leftHandMarkerText.setAttribute('value', 'Hand L\nno signal');
      if (this.leftJointAxes) this.leftJointAxes.forEach(function(e) { e.setAttribute('visible', 'false'); });
    }
    if (!this._handSeenRight) {
      if (this.rightHandMarkerText) this.rightHandMarkerText.setAttribute('value', 'Hand R\nno signal');
      if (this.rightJointAxes) this.rightJointAxes.forEach(function(e) { e.setAttribute('visible', 'false'); });
    }

    // Send combined packet if WebSocket is open and at least one controller has valid data
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        // 修改发送条件：只要有位置数据就发送，不检查是否为(0,0,0)
        const hasValidLeft = leftController.position !== null;
        const hasValidRight = rightController.position !== null;
        const hasValidHeadset = headset.position !== null;
        
        if (hasValidLeft || hasValidRight || hasValidHeadset) {
            // Build diagnostic info for hand tracking
            let handDebug = { hasSession: false, hasFrame: false, inputSourceCount: 0, sources: [],
                               handTrackingRequested: this._handTrackingRequested,
                               refSpaceLocal: !!this._handRefSpace,
                               extraction: { entriesOk: this._handEntriesOk, jointCount: this._handJointCount,
                                            poseHits: this._handPoseHits, poseMisses: this._handPoseMisses,
                                            err: this._handExtractErr } };
            try {
                const r = this.el.sceneEl.renderer;
                if (r && r.xr) {
                    const s = r.xr.getSession();
                    handDebug.hasSession = !!s;
                    handDebug.hasFrame = !!r.xr.getFrame();
                    if (s) {
                        handDebug.inputSourceCount = s.inputSources.length;
                        for (const src of s.inputSources) {
                            handDebug.sources.push({
                                handedness: src.handedness,
                                hasHand: !!src.hand,
                                hasGamepad: !!src.gamepad,
                                profiles: src.profiles || []
                            });
                        }
                    }
                }
            } catch(e) { handDebug.error = e.message; }

            const dualControllerData = {
                timestamp: Date.now(),
                leftController: leftController,
                rightController: rightController,
                headset: headset,
                leftHand: leftHandData,
                rightHand: rightHandData,
                _handDebug: handDebug
            };
            this.websocket.send(JSON.stringify(dualControllerData));

            // 添加调试信息
            console.log('Sending VR data:', {
                left: hasValidLeft ? 'valid' : 'invalid',
                right: hasValidRight ? 'valid' : 'invalid',
                headset: hasValidHeadset ? 'valid' : 'invalid',
                leftHand: leftHandData ? leftHandData.landmarks.length + ' landmarks' : 'none',
                rightHand: rightHandData ? rightHandData.landmarks.length + ' landmarks' : 'none',
                leftPos: leftController.position,
                rightPos: rightController.position,
                headsetPos: headset.position
            });
        }
    }
  }
});


// Add the component to the scene after it's loaded
document.addEventListener('DOMContentLoaded', (event) => {
    const scene = document.querySelector('a-scene');

    if (scene) {
        // Listen for controller connection events
        scene.addEventListener('controllerconnected', (evt) => {
            console.log('Controller CONNECTED:', evt.detail.name, evt.detail.component.data.hand);
        });
        scene.addEventListener('controllerdisconnected', (evt) => {
            console.log('Controller DISCONNECTED:', evt.detail.name, evt.detail.component.data.hand);
        });

        // Add controller-updater component when scene is loaded (A-Frame manages session)
        if (scene.hasLoaded) {
            scene.setAttribute('controller-updater', '');
            console.log("controller-updater component added immediately.");
        } else {
            scene.addEventListener('loaded', () => {
                scene.setAttribute('controller-updater', '');
                console.log("controller-updater component added after scene loaded.");
            });
        }
    } else {
        console.error('A-Frame scene not found!');
    }

    // Add controller tracking button logic
    addControllerTrackingButton();
});

function addControllerTrackingButton() {
    if (navigator.xr) {
        navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
            if (supported) {
                // Create Start Controller Tracking button
                const startButton = document.createElement('button');
                startButton.id = 'start-tracking-button';
                startButton.textContent = 'Start Controller Tracking';
                startButton.style.position = 'fixed';
                startButton.style.top = '50%';
                startButton.style.left = '50%';
                startButton.style.transform = 'translate(-50%, -50%)';
                startButton.style.padding = '20px 40px';
                startButton.style.fontSize = '20px';
                startButton.style.fontWeight = 'bold';
                startButton.style.backgroundColor = '#4CAF50';
                startButton.style.color = 'white';
                startButton.style.border = 'none';
                startButton.style.borderRadius = '8px';
                startButton.style.cursor = 'pointer';
                startButton.style.zIndex = '9999';
                startButton.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)';
                startButton.style.transition = 'all 0.3s ease';

                // Hover effects
                startButton.addEventListener('mouseenter', () => {
                    startButton.style.backgroundColor = '#45a049';
                    startButton.style.transform = 'translate(-50%, -50%) scale(1.05)';
                });
                startButton.addEventListener('mouseleave', () => {
                    startButton.style.backgroundColor = '#4CAF50';
                    startButton.style.transform = 'translate(-50%, -50%) scale(1)';
                });

                startButton.onclick = () => {
                    console.log('Start Controller Tracking button clicked. Requesting session via A-Frame...');
                    const sceneEl = document.querySelector('a-scene');
                    if (sceneEl) {
                        // Use A-Frame's enterVR to handle session start
                        sceneEl.enterVR(true).catch((err) => {
                            console.error('A-Frame failed to enter VR/AR:', err);
                            alert(`Failed to start AR session via A-Frame: ${err.message}`);
                        });
                    } else {
                         console.error('A-Frame scene not found for enterVR call!');
                    }
                };

                document.body.appendChild(startButton);
                console.log('Official "Start Controller Tracking" button added.');

                // Listen for VR session events to hide/show start button
                const sceneEl = document.querySelector('a-scene');
                if (sceneEl) {
                    sceneEl.addEventListener('enter-vr', () => {
                        console.log('Entered VR - hiding start button');
                        startButton.style.display = 'none';
                    });

                    sceneEl.addEventListener('exit-vr', () => {
                        console.log('Exited VR - showing start button');
                        startButton.style.display = 'block';
                    });
                }

            } else {
                console.warn('immersive-ar session not supported by this browser/device.');
            }
        }).catch((err) => {
            console.error('Error checking immersive-ar support:', err);
        });
    } else {
        console.warn('WebXR not supported by this browser.');
    }
} 