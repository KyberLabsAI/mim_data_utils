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
    constructor(name, vertices, indices, color, scale) {
        this.name = name;

        this.vertices = vertices;
        this.indices = indices;
        this.color = color;
        this.scale = scale;

        this.mesh = null;
    }

    buildObject() {
        // 3D Object (defined by vertices and faces)
        const geometry = new THREE.BufferGeometry();

        geometry.setAttribute( 'position', new THREE.BufferAttribute(this.vertices, 3 ) );
        geometry.setIndex(this.indices);
        geometry.computeVertexNormals(); // Important for lighting!

        const material = new THREE.MeshPhongMaterial({
            color: this.color
        });
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

class Viewer3D {
    constructor(container) {
        this.container = container;
        this.initScene();

        this.objects = new Map();
        this.currentTimestepData = null;
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

    addObject(obj) {
        this.objects.set(obj.name, obj);
        this.scene.add(obj.getObject());
    }

    setTime(time) {
        let tsd = traces.timestepData;
        for (var entry of tsd) {
            if (entry.get('time') > time) {
                break;
            }
        }
        this.currentTimestepData = entry;
    }

    render() {
        if (!this.currentTimestepData) {
            this.setTime(Number.POSITIVE_INFINITY)
        }
        let currentTimestep = this.currentTimestepData;
        for (const [name, entry] of this.objects.entries()) {
            let path = `${name}/pos`;
            if (currentTimestep.has(path)) {
                let data = currentTimestep.get(path);
                entry.getObject().position.set(...data.slice(0, 3));
                entry.getObject().rotation.set(...data.slice(3));
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


let viewer = new Viewer3D(document.getElementById('viewer'));

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
viewer.addObject(plane)

function addUpdateObject(data) {
    if (!(data.vertices instanceof Float32Array)) {
        data.vertices = new Float32Array(data.vertices)
    }
    if (typeof data.color == 'string') {
        data.color = parseInt(data.color);
    }

    // let mesh = new Mesh3D(data.name, data.vertices, data.indices, data.color, data.scale)
    viewer.addObject(new Mesh3D('3d/sphere', data.vertices, data.indices, data.color, data.scale));
}

function event3DCallback(type, evt, data) {
    switch(type) {
        case 'Traces::setStaticData':
            let payload = traces.staticData.get(data);
            if (payload.type == '3dMesh') {
                addUpdateObject(payload);
            }
        break;
    }
}

// Resize
window.addEventListener('resize', () => {
    viewer.resize()
});


// Animation loop
function animate() {
    requestAnimationFrame(animate);

    viewer.render();
}
