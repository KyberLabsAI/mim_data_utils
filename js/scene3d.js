class Plane3D {
    constructor(name) {
        this.name = name;

        // Ground plane (to receive shadows)
        const planeGeometry = new THREE.PlaneGeometry(1, 1);
        const planeMaterial = new THREE.MeshPhongMaterial({ color: 0x808080 }); // Gray
        const plane = this.plane = new THREE.Mesh(planeGeometry, planeMaterial);
        // plane.rotation.x = -Math.PI / 2; // Rotate to be horizontal
        plane.receiveShadow = true; // Plane receives shadows
    }

    buildObject() {
        return this.plane;
    }

    getObject() {
        return this.plane;
    }
}

class Mesh3D {
    constructor(name, vertices, indices, material, scale) {
        this.name = name;

        this.vertices = vertices;
        this.indices = indices;
        this.material = material;
        this.scale = scale;

        this.mesh = null;
    }

    buildObject() {
        // 3D Object (defined by vertices and faces)
        const geometry = new THREE.BufferGeometry();

        geometry.setAttribute( 'position', new THREE.BufferAttribute(this.vertices, 3 ) );
        geometry.setIndex(this.indices);
        geometry.computeVertexNormals(); // Important for lighting!

        const material = new THREE.MeshPhongMaterial(this.material);
        const mesh = this.mesh = new THREE.Mesh(geometry, material);
        mesh.scale.set(...this.scale);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        this.mesh = mesh;
        return mesh;
    }

    getObject() {
        return this.mesh || this.buildObject();
    }
}

// Free-fly camera controller (replaces OrbitControls). The camera moves
// freely through the scene rather than orbiting a fixed pivot.
//
//   LMB drag        : trackball look (axis ⊥ to drag, in camera screen plane)
//   RMB drag        : pan (translate perpendicular to view)
//   ALT + LMB drag  : pan (alternate to RMB)
//   Mouse wheel     : fly forward / backward along the view direction
//   W/A/S/D         : strafe (forward / left / back / right)
//   E / Q           : up / down along the camera's local up axis
//
// Exposes the same shape OrbitControls did (`enabled`, `target`, `update()`)
// so the rest of the viewer (headlight tracking, updateLocation()) keeps
// working unchanged. `target` is no longer a fixed orbit pivot — it's a
// derived point one unit in front of the camera, refreshed whenever the
// camera moves; the headlight uses it as its aim direction.
class FreeCameraControls {
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.enabled = true;

        // Tunables.
        this.rotateSpeed = 0.0035;     // radians per pixel of mouse drag
        this.panSpeed   = 0.002;       // world units per pixel
        this.wheelSpeed = 0.001;       // world units per wheel tick
        this.keySpeed   = 1.0;         // world units per second when key held

        this.target = new THREE.Vector3();
        this._updateTarget();

        this._dragging = null;          // null | 'rotate' | 'pan'
        this._lastX = 0;
        this._lastY = 0;
        this._keys = new Set();
        this._lastUpdateTime = performance.now();

        // Mouse + wheel.
        this._onMouseDown = (e) => {
            if (!this.enabled) return;
            if (e.button === 0) {
                // Alt+LMB pans, plain LMB rotates.
                this._dragging = e.altKey ? 'pan' : 'rotate';
            } else if (e.button === 2) {
                this._dragging = 'pan';
            } else {
                return;
            }
            this._lastX = e.clientX;
            this._lastY = e.clientY;
            e.preventDefault();
        };
        this._onMouseUp = () => { this._dragging = null; };
        this._onMouseMove = (e) => {
            if (!this.enabled || !this._dragging) return;
            const dx = e.clientX - this._lastX;
            const dy = e.clientY - this._lastY;
            this._lastX = e.clientX;
            this._lastY = e.clientY;
            if (this._dragging === 'rotate') this._rotate(dx, dy);
            else if (this._dragging === 'pan') this._pan(dx, dy);
        };
        this._onContextMenu = (e) => e.preventDefault();
        this._onWheel = (e) => {
            if (!this.enabled) return;
            e.preventDefault();
            const dir = new THREE.Vector3();
            this.camera.getWorldDirection(dir);
            this.camera.position.addScaledVector(dir, -e.deltaY * this.wheelSpeed);
            this._updateTarget();
        };

        // Keyboard (window-level so focus on the canvas isn't required).
        // Ignore key events when an editable element has focus so typing in
        // a text box / textarea / contenteditable doesn't fly the camera.
        const _isTyping = () => {
            const el = document.activeElement;
            if (!el || el === document.body) return false;
            const tag = el.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
            return el.isContentEditable === true;
        };
        this._onKeyDown = (e) => {
            if (!this.enabled) return;
            if (_isTyping()) return;
            this._keys.add(e.code);
        };
        this._onKeyUp = (e) => {
            // Always clear so a key released outside a text box doesn't stick.
            this._keys.delete(e.code);
        };

        domElement.addEventListener('mousedown', this._onMouseDown);
        domElement.addEventListener('contextmenu', this._onContextMenu);
        domElement.addEventListener('wheel', this._onWheel, { passive: false });
        window.addEventListener('mouseup', this._onMouseUp);
        window.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
    }

    _rotate(dx, dy) {
        const camera = this.camera;
        // Trackball-style: rotate around an axis perpendicular to the drag
        // direction in screen space. The axis lies in the camera's local
        // XY (screen) plane, then is transformed into world space via the
        // current camera orientation. This makes the rotation always feel
        // proportional to the drag direction regardless of camera tilt —
        // a horizontal drag yaws around the camera's local up, a vertical
        // drag pitches around the camera's local right, and diagonal
        // drags rotate around the corresponding diagonal axis.
        const angle = -Math.hypot(dx, dy) * this.rotateSpeed;
        if (Math.abs(angle) < 1e-9) return;
        const axisLocal = new THREE.Vector3(dy, dx, 0).normalize();
        const axisWorld = axisLocal.applyQuaternion(camera.quaternion);
        const q = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle);
        camera.quaternion.premultiply(q);
        camera.quaternion.normalize();
        this._updateTarget();
    }

    _pan(dx, dy) {
        const camera = this.camera;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        camera.position.addScaledVector(right, -dx * this.panSpeed);
        camera.position.addScaledVector(up,     dy * this.panSpeed);
        this._updateTarget();
    }

    _updateTarget() {
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        this.target.copy(this.camera.position).add(dir);
    }

    update() {
        const now = performance.now();
        const dt = (now - this._lastUpdateTime) / 1000;
        this._lastUpdateTime = now;
        if (!this.enabled || this._keys.size === 0) return;

        const camera = this.camera;
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

        const move = new THREE.Vector3();
        if (this._keys.has('KeyW')) move.addScaledVector(dir, 1);
        if (this._keys.has('KeyS')) move.addScaledVector(dir, -1);
        if (this._keys.has('KeyD')) move.addScaledVector(right, 1);
        if (this._keys.has('KeyA')) move.addScaledVector(right, -1);
        if (this._keys.has('KeyE')) move.addScaledVector(localUp, 1);
        if (this._keys.has('KeyQ')) move.addScaledVector(localUp, -1);

        if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(this.keySpeed * dt);
            camera.position.add(move);
            this._updateTarget();
        }
    }
}


class ControlableViewer {
    constructor(aspectRation, domElement) {
        let camera = this.camera = new THREE.PerspectiveCamera(50, aspectRation, 0.001, 1000);
        camera.position.set(1.5, 1.5, 1.5);
        camera.up.set(0, 0, 1);
        camera.lookAt(0, 0, 0);

        this.controls = new FreeCameraControls(camera, domElement);
    }

    updateAspect(aspectRation) {
        this.camera.aspect = aspectRation;
        this.camera.updateProjectionMatrix();
    }

    updateControls() {
        this.controls.update();
    }

    toggleControls(enabled) {
        this.controls.enabled = enabled;
    }

    updateLocation(position, lookAt) {
        let cam = this.camera;
        cam.position.set(...position);
        cam.lookAt(...lookAt);
        this.controls._updateTarget();
    }
}

let hasXR = false;
if ( typeof navigator !== 'undefined' && 'xr' in navigator ) {
    hasXR = true;
}


class Pose {
    constructor(pos, quat) {
        this.position = pos.clone();
        this.quaternion = quat.clone();
    }
}

class Scene3D {
    constructor(container) {
        this.container = container;

        this.viewers = []
        this.objects = new Map();
        this.currentTimestepData = null;
        this.time = null;
        this.lastPoseUpdateTime = null;
        this.lastRenderCameraPose = null;

        this.xrMotionState = {
            started: false,
            xRefBegin: null,
            controllerBegin: null
        }

        this.initScene();

    }

    addViewer(aspectRation) {
        let viewer = new ControlableViewer(aspectRation, this.renderer.domElement);
        this.viewers.push(viewer);
        this.resize();
    }

    updateCamera(cameraIndex, position, lookAt) {
        if (cameraIndex >= this.viewers.length) {
            return;
        }

        this.viewers[cameraIndex].updateLocation(position, lookAt);
    }

    xrUpdateReferenceSpace(pose) {
        const vrPos = pose.position;
        const vrQuat = pose.quaternion;

        const xrPosition = new DOMPointReadOnly(-vrPos.x, -vrPos.y, -vrPos.z);
        const xrOrientation = new DOMPointReadOnly(vrQuat.x, vrQuat.y, vrQuat.z, vrQuat.w);
        const offsetTransform = new XRRigidTransform(xrPosition, xrOrientation);

        let viewerReferenceSpace = this.renderer.xr.getReferenceSpace();
        let customViewerReferenceSpace = viewerReferenceSpace.getOffsetReferenceSpace(offsetTransform);

        // Now, tell the Three.js WebXRManager to use this new reference space
        this.renderer.xr.setReferenceSpace(customViewerReferenceSpace);
    }

    initScene() {
        // Scene
        const scene = this.scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1a2e); // Dark navy/charcoal

        // Renderer
        const renderer = this.renderer = new THREE.WebGLRenderer({
            antialias: true
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.xr.enabled = true;
        renderer.xr.setReferenceSpaceType('local');
        renderer.setAnimationLoop(this.render.bind(this));
        document.body.appendChild(renderer.domElement);

        renderer.domElement.addEventListener('pointerdown', (evt) => {
            let viewerIdx = this._getViewerIndexAt(evt.offsetX, evt.offsetY);
            this.viewers.forEach((viewer, i) => {
                viewer.toggleControls(i == viewerIdx);
            })
        });

        if (hasXR) {
            navigator.xr.isSessionSupported('immersive-vr').then(supported => {
                if (supported) {
                    document.body.appendChild(VRButton.createButton(renderer));
                }
            });

            renderer.xr.addEventListener('sessionstart', () => {
                // Switch to 3d-only layout for VR.
                applyPanelLayout('3d', true);

                // Update the VR headset position to match the camera.
                let cameraPos = this.lastRenderCameraPose.position;
                let cameraQuat = this.lastRenderCameraPose.quaternion;

                const vrQuat = new THREE.Quaternion(
                    -cameraQuat.x, -cameraQuat.y, -cameraQuat.z, cameraQuat.w);

                const vrPos = cameraPos.applyQuaternion(vrQuat.clone())

                this.xrMotionState.xRefBegin = new Pose(vrPos, vrQuat);
                this.xrUpdateReferenceSpace(this.xrMotionState.xRefBegin);
            });
        }

        // Start with a single view on the scene.
        this.addViewer(window.innerWidth / window.innerHeight);

        // Lighting: SolidWorks-style three-light setup

        // 1. HemisphereLight (ambient gradient)
        const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x1a1a2e, 3.5);
        scene.add(hemiLight);

        // 2. AmbientLight (baseline fill)
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.15);
        scene.add(ambientLight);

        // 3. DirectionalLight (camera-relative headlight)
        const headlight = this.headlight = new THREE.DirectionalLight(0xffffff, 0.85);
        headlight.castShadow = true;
        scene.add(headlight);
        scene.add(headlight.target);

        // Shadow configuration
        headlight.shadow.mapSize.width = 2048;
        headlight.shadow.mapSize.height = 2048;
        headlight.shadow.camera.near = 0.5;
        headlight.shadow.camera.far = 100;
        headlight.shadow.camera.left = -20;
        headlight.shadow.camera.right = 20;
        headlight.shadow.camera.bottom = -20;
        headlight.shadow.camera.top = 20;
        headlight.shadow.bias = -0.001;

        this.container.appendChild(renderer.domElement);

        // const cameraHelper = new THREE.CameraHelper(headlight.shadow.camera);
        // scene.add(cameraHelper); // Helpful for visualizing

        this.resize();
    }

    _updateHeadlight() {
        if (this.viewers.length === 0) return;

        const viewer = this.viewers[0];
        const camera = viewer.camera;
        const target = viewer.controls.target;

        // Compute light position: 5 units above and 3 units to the right in camera-local coords
        const offset = new THREE.Vector3(3, 5, 0);
        offset.applyQuaternion(camera.quaternion);
        this.headlight.position.copy(camera.position).add(offset);
        this.headlight.target.position.copy(target);
    }

    _getViewerIndexAt(x, y) {
        return Math.floor(x / this.viewerWidth);
    }

    _removeObjectAndChildren(object) {
        let scene = this.scene;

        if (!object) return; // Safety check: Make sure the object exists

        // Recursively remove children first
        while (object.children.length > 0) {
          const child = object.children[0]; // Get the first child
          removeObjectAndChildren(child, scene); // Recursively call this function for the child
        }

        // Now that all children are removed, remove the object itself
        scene.remove(object);

        // Dispose of geometry
        if (object.geometry) {
          object.geometry.dispose();
        }

        // Dispose of materials (handle both single materials and arrays of materials)
        if (object.material) {
          if (Array.isArray(object.material)) {
            object.material.forEach(material => {
              if (material) material.dispose(); // Check if material exists before disposing
            });
          } else {
            if (object.material) object.material.dispose(); // Check if material exists before disposing
          }
        }
    }

    clear() {
        for (const [name, entry] of this.objects.entries()) {
            this._removeObjectAndChildren(entry.getObject());
        }

        this.viewers = this.viewers.slice(0, 1); // Only keep the first viewer.

        this.resize();
    }

    addObject(obj) {
        this.objects.set(obj.name, obj);
        this.scene.add(obj.getObject());

        // Force objects to get re-positioned.
        this.lastPoseUpdateTime = null;
    }

    setTime(time) {
        this.time = time;
    }

    absoluteTime() {
        if (this.time == null) {
            return traces.getLastTime();
        } else {
            return this.time;
        }
    }

    _renderViewer(viewer, idx) {
        let renderer = this.renderer;
        let x = idx * this.viewerWidth;
        renderer.setViewport(x, 0, this.viewerWidth, this.height);
        renderer.setScissor(x, 0, this.viewerWidth, this.height);
        renderer.setScissorTest(true);
        renderer.render(this.scene, viewer.camera);
        renderer.setScissorTest(false);
    }


    xrHandleController(time, frame) {
        const renderer = this.renderer;
        const xrRefSpace = renderer.xr.getReferenceSpace();
        const xrSession = renderer.xr.getSession();

        if (!xrSession || !xrRefSpace) {
            return;
        }

        for (const inputSource of xrSession.inputSources) {
            if (!inputSource.gamepad || !inputSource.gripSpace) {
                continue;
            }

            // Get the pose of the physical controller relative to your reference space
            const gripPose = frame.getPose(inputSource.gripSpace, xrRefSpace);
            const gamepad = inputSource.gamepad;

            if (!gripPose) {
                continue;
            }

            // The position is available in gripPose.transform.position
            const tPos = gripPose.transform.position; // This is an XRRigidTransform object
            const tQuat = gripPose.transform.orientation;

            const position = new THREE.Vector3(tPos.x, tPos.y, tPos.x);
            const orientation = new THREE.Quaternion(tQuat.x, tQuat.y, tQuat.z, tQuat.w)

            let motionState = this.xrMotionState;
            let buttonXPRessed = gamepad.buttons[4].pressed;
            let buttonYPRessed = gamepad.buttons[5].pressed;
            if ((buttonXPRessed || buttonYPRessed) && !motionState.started) {
                motionState.started = true;
                motionState.controllerBegin = new Pose(position, orientation);
            } else if (buttonXPRessed || buttonYPRessed) {
                let posDiff = position.sub(motionState.controllerBegin.position);

                if (buttonXPRessed) {
                    posDiff.multiply(new THREE.Vector3(0.01, 0.02, 0));
                } else {
                    posDiff = new THREE.Vector3(0, 0, 0.01 * posDiff.y);
                }

                let newPose = new Pose(posDiff, new THREE.Quaternion(0, 0, 0, 1));
                this.xrUpdateReferenceSpace(newPose);
            } else {
                motionState.started = false;
            }

            // console.log(`Gamepad: ${gamepad.id} - button X, Y: ${buttonXPRessed}, ${buttonYPRessed}`);
            // console.log(gamepad.buttons);
            // console.log(`  Pos:  ${position.x.toFixed(3)}, ${position.y.toFixed(3)}, ${position.z.toFixed(3)}`);
            // console.log(`  Quat: ${orientation.x.toFixed(3)}, ${orientation.y.toFixed(3)}, ${orientation.z.toFixed(3)}, ${orientation.w.toFixed(3)}`);
        }
    }

    render(renderTime, xrFrame) {
        let time;
        if (this.time !== null) {
            time = this.time;
        } else {
            time = traces.getLastTime();
        }

        if (time != this.lastPoseUpdateTime) {
            this.lastPoseUpdateTime = time;

            for (const [name, entry] of this.objects.entries()) {
                let obj = entry.getObject();

                let path = `${name}/pos`;
                let data = traces.dataAtTime(path, time);
                if (data) {
                    obj.position.set(...data.slice(0, 3));
                    obj.quaternion.set(...data.slice(3))
                }

                path = `${name}/color`;
                data = traces.dataAtTime(path, time);
                if (data) {
                    let material = entry.mesh.material;
                    parseMaterialColor(data, material);
                    material.needsUpdate = true;
                }
            }
        }

        // Drive time-driven scene objects (e.g. PointCloud3D) every frame.
        // Each object self-guards via lastRenderedTime, so this is cheap
        // when nothing has changed.
        for (const entry of this.objects.values()) {
            if (entry.syncToTime) {
                entry.syncToTime(time);
            }
        }

        if (xrFrame) {
            this.xrHandleController(renderTime, xrFrame);
        }

        this._updateHeadlight();

        this.viewers.forEach((viewer, i) => {
            viewer.updateControls();
            this._renderViewer(viewer, i);
        });

        let firstCamera = this.viewers[0].camera;
        this.lastRenderCameraPose = new Pose(firstCamera.position, firstCamera.quaternion);
    }

    resize() {
        // this.container.removeChild(canvas);
        const width = this.container.offsetWidth;
        const height = this.container.offsetHeight;
        this.width = width;
        this.height = height;

        this.renderer.setSize(width, height);

        let viewers = this.viewers;
        let splits = viewers.length;
        let viewerWidth = this.viewerWidth = Math.floor(width / splits);

        viewers.forEach(viewer => {
            viewer.updateAspect(viewerWidth / height);
        });
    }
}

const vertices = new Float32Array([
    -1.0, -1.0,  1.0, // Vertex 0
     1.0, -1.0,  1.0, // Vertex 1
     0.0,  1.0,  0.0, // Vertex 2
    -1.0, -1.0, -1.0, // Vertex 3
     1.0, -1.0, -1.0, // Vertex 4
]);

const indices = [
    0, 1, 2, // Triangle 1
    0, 2, 3, // Triangle 2
    1, 2, 4, // Triangle 3
    0, 3, 4, // Triangle 4
    1, 4, 3, // Triangle 5
];


function colorArrayToNumber(arr) {
    let res = 0;
    arr.forEach((val, i) => {
        res += Math.floor(val) << (8 * (2 - i));
    });
    return res;
}

function timeStepAmount(amount) {
    return amount = amount || 0.05;
}

function stepBack(amount) {
    scene.time -= timeStepAmount(amount);
}

function stepForward(amount) {
    scene.time += timeStepAmount(amount);
}

function parseMaterialColor(color, material) {
    if (typeof color == 'string') {
        if (color.length == 6) {
            material.transparent = false;
            colorValue = parseInt(color, 16);
        } else {
            material.transparent = true;
            material.opacity = parseInt(color.substring(6), 16) / 255;
            colorValue = parseInt(color.substring(0, 6), 16);
        }
    } else if (color.length == 3) {
        material.transparent = false;
        colorValue = colorArrayToNumber(color);
    } else if (color.length == 4) {
        material.transparent = true;
        material.opacity = color[3] / 255;
        colorValue = colorArrayToNumber(color.slice(0, 3));
    }
    material.color = new THREE.Color(colorValue);
}

function addUpdateObject(data) {
    if (!(data.vertices instanceof Float32Array)) {
        data.vertices = new Float32Array(data.vertices)
    }

    if (!data.material) {
        data.material = {};
    }

    parseMaterialColor(data.material.color || 'dddddd', data.material)
    scene.addObject(new Mesh3D(data.name, data.vertices, data.indices, data.material, data.scale));
}

function event3DCallback(type, evt, data) {
    switch(type) {
        case 'Traces::recordStaticData':
            let payload = traces.staticData.get(data);
            if (payload.type == '3dMesh') {
                addUpdateObject(payload);
            } else if (payload.type == 'pointcloud') {
                // payload.name is already the '3d/<user-name>' key set by
                // Scene.to_static_dict, so PointCloud3D registers under the
                // same name Scene3D uses for pose updates.
                const pc = new PointCloud3D(payload);
                scene.addObject(pc);
            }
        break;
    }
}

// Resize
window.addEventListener('resize', () => {
    scene.resize()
});

