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
        this.cam.position.set(position);
        this.cam.lookAt(...lookAt);
    }
}

class Scene3D {
    constructor(container) {
        this.container = container;

        this.viewers = []
        this.objects = new Map();
        this.currentTimestepData = null;
        this.time = null;

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

        this.viewer[cameraIndex].updateLocation(position, lookAt);
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
        document.body.appendChild(renderer.domElement);

        renderer.domElement.addEventListener('pointerdown', (evt) => {
            let viewerIdx = this._getViewerIndexAt(evt.offsetX, evt.offsetY);
            this.viewers.forEach((viewer, i) => {
                viewer.toggleControls(i == viewerIdx);
            })
        });

        // Start with a single view on the scene.
        this.addViewer(window.innerWidth / window.innerHeight);

        // Light
        const ambientLight = new THREE.AmbientLight(0x404040); // Soft white light
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
    }

    addObject(obj) {
        this.objects.set(obj.name, obj);
        this.scene.add(obj.getObject());
    }

    setTime(time) {
        this.time = time;
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

    render() {
        let time;
        if (this.time !== null) {
            time = this.time;
        } else {
            time = traces.getLastTime();
        }

        for (const [name, entry] of this.objects.entries()) {
            let path = `${name}/pos`;
            let data = traces.dataAtTime(path, time);
            if (data) {
                let obj = entry.getObject();
                obj.position.set(...data.slice(0, 3));
                obj.quaternion.set(...data.slice(3))
            }
        }


        this.viewers.forEach((viewer, i) => {
            viewer.updateControls();
            this._renderViewer(viewer, i);
        })

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


let scene = new Scene3D(document.getElementById('viewer'));

// let mesh = new Mesh3D('triangle', vertices, indices, 0x007bff, [1., 1., 1.])
// viewer.addObject(mesh.buildObject());

// setTimeout(() => {
//     name = '3d/sphere'
//     parsewebSocketData({
//         '__static__': true,
//         'name': name,
//         'data': {
//             'name': name,
//             'type': '3dMesh',
//             'vertices': vertices,
//             'indices': indices,
//             'scale': [1., 1., 1.],
//             'color': '0x007bff'
//         }
//     })
// }, 1000);

let plane = new Plane3D('plane')
scene.addObject(plane)

function colorArrayToNumber(arr) {
    let res = 0;
    arr.forEach((val, i) => {
        res += Math.floor(val * 255) << (8 * (2 - i));
    });
    return res;
}

function addUpdateObject(data) {
    if (!(data.vertices instanceof Float32Array)) {
        data.vertices = new Float32Array(data.vertices)
    }

    if (!data.material) {
        data.material = {};
    }

    if (data.material.color) {
        let color = data.material.color;
        if (typeof color == 'string') {
            color = parseInt(color, 16);
        } else if (color.length == 3) {
            color = colorArrayToNumber(color);
        } else if (color.length == 4) {
            data.material.transparent = true;
            data.material.opacity = color[3];
            color = colorArrayToNumber(color.slice(0, 3));
        }
        data.material.color = color;
    } else {
        data.material.color = parseInt('dddddd', 16); // Gray.
    }

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
            } else if (payload.type == '3dCamera') {
                scene.addViewer();
            } else if (payload.type == '3dCameraLocation') {
                scene.updateCamera(data.cameraIndex, data.position, data.lookAt);
            }
        break;
    }
}

// Resize
window.addEventListener('resize', () => {
    scene.resize()
});

