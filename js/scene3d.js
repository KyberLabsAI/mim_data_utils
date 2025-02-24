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

class Scene3D {
    constructor(container) {
        this.container = container;
        this.initScene();

        this.objects = new Map();
        this.currentTimestepData = null;
        this.time = null;
    }

    initScene() {
        // Scene
        const scene = this.scene = new THREE.Scene();
        scene.background = new THREE.Color(0xaaaaaa); // Light gray background

        // Camera
        const camera = this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.001, 1000);
        camera.position.z = 1;
        camera.up.set(0, 0, 1)

        // Renderer
        const renderer = this.renderer = new THREE.WebGLRenderer({
            antialias: true
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.shadowMap.enabled = true; // Enable shadows
        document.body.appendChild(renderer.domElement);

        // Orbit Controls
        const controls = this.controls = new OrbitControls(camera, renderer.domElement);

        // Light
        const ambientLight = new THREE.AmbientLight(0x404040); // Soft white light
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.); // White directional light
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

        this.controls.update(); // Update orbit controls
        this.renderer.render(this.scene, this.camera);
    }

    resize() {
        // this.container.removeChild(canvas);
        const width = this.container.offsetWidth;
        const height = this.container.offsetHeight;

        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
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

function addUpdateObject(data) {
    if (!(data.vertices instanceof Float32Array)) {
        data.vertices = new Float32Array(data.vertices)
    }
    if (typeof data.color == 'string') {
        data.color = parseInt(data.color);
    }

    scene.addObject(new Mesh3D(data.name, data.vertices, data.indices, data.material, data.scale));
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


// Animation loop
function animate() {
    requestAnimationFrame(animate);

    scene.render();
}
