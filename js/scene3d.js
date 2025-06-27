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

class ControlableViewer {
    constructor(aspectRation, domElement) {
        let camera = this.camera = new THREE.PerspectiveCamera(75, aspectRation, 0.001, 1000);
        camera.position.z = 1;
        camera.up.set(0, 0, 1)

        this.controls = new OrbitControls(camera, domElement);
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
        scene.background = new THREE.Color(0xaaaaaa); // Light gray background

        // Renderer
        const renderer = this.renderer = new THREE.WebGLRenderer({
            antialias: true
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.shadowMap.enabled = true; // Enable shadows
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
            document.body.appendChild(VRButton.createButton(renderer));

            renderer.xr.addEventListener('sessionstart', () => {
                // Hide the plot in VR.
                toggleScene(VIEW_STATE_SCENE_ONLY);

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

        // Light
        const ambientLight = new THREE.AmbientLight(0x404040, 3.); // Soft white light
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 3.); // White directional light
        directionalLight.position.set(.03, .03, .03).normalize(); // From top right
        directionalLight.castShadow = true; // Cast shadows
        scene.add(directionalLight);
        this.directionalLight = directionalLight


        // Set up shadow properties for the light (important!)
        directionalLight.shadow.mapSize.width = 4096;  // Adjust for shadow quality
        directionalLight.shadow.mapSize.height = 4096;
        directionalLight.shadow.camera.near = 0.01;    // Adjust near/far for shadow rendering
        directionalLight.shadow.camera.far = 2;

        let shadowSize = 1.2
        directionalLight.shadow.camera.left = -shadowSize;
        directionalLight.shadow.camera.right = shadowSize;
        directionalLight.shadow.camera.bottom = -shadowSize;
        directionalLight.shadow.camera.top = shadowSize;
        // Optional: visualize the shadow camera frustum (for debugging)
        // const helper = new THREE.CameraHelper( directionalLight.shadow.camera );
        // scene.add( helper );

        this.container.appendChild(renderer.domElement);

        // const cameraHelper = new THREE.CameraHelper(directionalLight.shadow.camera);
        // scene.add(cameraHelper); // Helpful for visualizing

        this.resize();
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

        if (xrFrame) {
            this.xrHandleController(renderTime, xrFrame);
        }

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


    // HACK: If a new object is added and scene is not visible, make it visible.
    if (!isSceneDisplayed()) {
        toggleScene(1);
    }
}

function event3DCallback(type, evt, data) {
    switch(type) {
        case 'Traces::recordStaticData':
            let payload = traces.staticData.get(data);
            if (payload.type == '3dMesh') {
                addUpdateObject(payload);
            }
        break;
    }
}

// Resize
window.addEventListener('resize', () => {
    scene.resize()
});

