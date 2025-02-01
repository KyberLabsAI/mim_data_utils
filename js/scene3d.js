class Plane3D {
    constructor(name) {
        this.name = name;

        // Ground plane (to receive shadows)
        const planeGeometry = new THREE.PlaneGeometry(10, 10);
        const planeMaterial = new THREE.MeshPhongMaterial({ color: 0x808080 }); // Gray
        const plane = this.plane = new THREE.Mesh(planeGeometry, planeMaterial);
        plane.rotation.x = -Math.PI / 2; // Rotate to be horizontal
        plane.receiveShadow = true; // Plane receives shadows
    }

    buildObject() {
        return this.plane;
    }
}

class Mesh3D {
    constructor(name, vertices, indices, color) {
        this.name = name;

        this.vertices = vertices;
        this.indices = indices;
        this.color = color;

        this.mesh = null;
    }

    buildObject() {
        // 3D Object (defined by vertices and faces)
        const geometry = new THREE.BufferGeometry();

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

        geometry.setAttribute( 'position', new THREE.BufferAttribute(this.vertices, 3 ) );
        geometry.setIndex(this.indices);
        geometry.computeVertexNormals(); // Important for lighting!

        const material = new THREE.MeshPhongMaterial({
            color: this.color
        });
        const mesh = this.mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;

        return mesh;
    }
}

class Viewer3D {
    constructor(container) {
        this.container = container;
        this.initScene();

        this.objects = new Map();
    }

    initScene() {
        // Scene
        const scene = this.scene = new THREE.Scene();
        scene.background = new THREE.Color(0xaaaaaa); // Light gray background

        // Camera
        const camera = this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.z = 5;

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
        directionalLight.position.set(1, 1, 1).normalize(); // From top right
        directionalLight.castShadow = true; // Cast shadows
        scene.add(directionalLight);


        // Set up shadow properties for the light (important!)
        directionalLight.shadow.mapSize.width = 1024;  // Adjust for shadow quality
        directionalLight.shadow.mapSize.height = 1024;
        directionalLight.shadow.camera.near = 0.5;    // Adjust near/far for shadow rendering
        directionalLight.shadow.camera.far = 500;
        // Optional: visualize the shadow camera frustum (for debugging)
        // const helper = new THREE.CameraHelper( directionalLight.shadow.camera );
        // scene.add( helper );

        this.container.appendChild(renderer.domElement);

        this.resize();
    }

    addObject(obj) {
        this.objects.set(obj.name, obj);
        this.scene.add(obj);
    }

    render() {
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

let mesh = new Mesh3D('triangle', vertices, indices, 0x007bff)
viewer.addObject(mesh.buildObject());

let plane = new Plane3D('plane')
viewer.addObject(plane.buildObject())


// Resize
window.addEventListener('resize', () => {
    viewer.resize()
});


// Animation loop
function animate() {
    requestAnimationFrame(animate);

    viewer.render();
}

animate();