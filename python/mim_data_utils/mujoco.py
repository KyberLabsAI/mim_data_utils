import numpy as np
import mujoco
import numbers
from scipy.spatial.transform import Rotation

from .scene import RawMesh
from .scene import mj2pin
from .scene import Pose


def _quat_wxyz_to_matrix(q):
    """MuJoCo wxyz quaternion to 3x3 rotation matrix (pure numpy)."""
    w, x, y, z = float(q[0]), float(q[1]), float(q[2]), float(q[3])
    x2, y2, z2 = x+x, y+y, z+z
    xx, xy, xz = x*x2, x*y2, x*z2
    yy, yz, zz = y*y2, y*z2, z*z2
    wx, wy, wz = w*x2, w*y2, w*z2
    return np.array([
        [1-(yy+zz), xy-wz,     xz+wy],
        [xy+wz,     1-(xx+zz), yz-wx],
        [xz-wy,     yz+wx,     1-(xx+yy)]
    ])


def _matrix_to_quat_xyzw(R):
    """3x3 rotation matrix to xyzw quaternion (scipy/scene convention)."""
    trace = R[0,0] + R[1,1] + R[2,2]
    if trace > 0:
        s = 0.5 / np.sqrt(trace + 1.0)
        w = 0.25 / s
        x = (R[2,1] - R[1,2]) * s
        y = (R[0,2] - R[2,0]) * s
        z = (R[1,0] - R[0,1]) * s
    elif R[0,0] > R[1,1] and R[0,0] > R[2,2]:
        s = 2.0 * np.sqrt(1.0 + R[0,0] - R[1,1] - R[2,2])
        w = (R[2,1] - R[1,2]) / s
        x = 0.25 * s
        y = (R[0,1] + R[1,0]) / s
        z = (R[0,2] + R[2,0]) / s
    elif R[1,1] > R[2,2]:
        s = 2.0 * np.sqrt(1.0 + R[1,1] - R[0,0] - R[2,2])
        w = (R[0,2] - R[2,0]) / s
        x = (R[0,1] + R[1,0]) / s
        y = 0.25 * s
        z = (R[1,2] + R[2,1]) / s
    else:
        s = 2.0 * np.sqrt(1.0 + R[2,2] - R[0,0] - R[1,1])
        w = (R[1,0] - R[0,1]) / s
        x = (R[0,2] + R[2,0]) / s
        y = (R[1,2] + R[2,1]) / s
        z = 0.25 * s
    return np.array([x, y, z, w])




def _rgba_material(rgba):
    """Convert MuJoCo RGBA (0-1) to material dict with 0-255 color."""
    if rgba is None:
        return {}
    color_255 = (np.clip(rgba, 0, 1) * 255).astype(int).tolist()
    return {'color': color_255}


def _make_plane_mesh(size, grid=5.0):
    """Create a flat quad mesh in the XY plane.

    MuJoCo plane size: [hx, hy, spacing]. If hx/hy are 0, use a large default.
    """
    hx = float(size[0]) if size[0] > 0 else grid
    hy = float(size[1]) if size[1] > 0 else grid
    vertices = np.array([
        [-hx, -hy, 0], [hx, -hy, 0], [hx, hy, 0], [-hx, hy, 0],
    ], dtype=np.float64)
    indices = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32)
    return vertices, indices


def _make_box_mesh(half_extents):
    """Create a box mesh from half-extents [hx, hy, hz]."""
    hx, hy, hz = float(half_extents[0]), float(half_extents[1]), float(half_extents[2])
    vertices = np.array([
        [-hx, -hy, -hz], [ hx, -hy, -hz], [ hx,  hy, -hz], [-hx,  hy, -hz],
        [-hx, -hy,  hz], [ hx, -hy,  hz], [ hx,  hy,  hz], [-hx,  hy,  hz],
    ], dtype=np.float64)
    indices = np.array([
        [0,1,2], [0,2,3],  # bottom
        [4,6,5], [4,7,6],  # top
        [0,4,5], [0,5,1],  # front
        [2,6,7], [2,7,3],  # back
        [0,3,7], [0,7,4],  # left
        [1,5,6], [1,6,2],  # right
    ], dtype=np.int32)
    return vertices, indices


def _make_sphere_mesh(radius, n_lat=12, n_lon=16):
    """Create a UV sphere mesh."""
    r = float(radius)
    vertices = [[0, 0, r]]  # top pole
    for i in range(1, n_lat):
        theta = np.pi * i / n_lat
        for j in range(n_lon):
            phi = 2 * np.pi * j / n_lon
            vertices.append([r * np.sin(theta) * np.cos(phi),
                             r * np.sin(theta) * np.sin(phi),
                             r * np.cos(theta)])
    vertices.append([0, 0, -r])  # bottom pole
    vertices = np.array(vertices, dtype=np.float64)

    indices = []
    # Top cap
    for j in range(n_lon):
        indices.append([0, 1 + j, 1 + (j + 1) % n_lon])
    # Body
    for i in range(n_lat - 2):
        for j in range(n_lon):
            a = 1 + i * n_lon + j
            b = 1 + i * n_lon + (j + 1) % n_lon
            c = 1 + (i + 1) * n_lon + (j + 1) % n_lon
            d = 1 + (i + 1) * n_lon + j
            indices.append([a, b, c])
            indices.append([a, c, d])
    # Bottom cap
    bottom = len(vertices) - 1
    base = 1 + (n_lat - 2) * n_lon
    for j in range(n_lon):
        indices.append([bottom, base + (j + 1) % n_lon, base + j])
    return vertices, np.array(indices, dtype=np.int32)


def _make_cylinder_mesh(radius, half_height, n_seg=16):
    """Create a cylinder mesh (capped) along Z axis."""
    r, h = float(radius), float(half_height)
    vertices = []
    indices = []

    # Bottom center, top center
    vertices.append([0, 0, -h])  # 0: bottom center
    vertices.append([0, 0,  h])  # 1: top center

    # Bottom ring (indices 2 .. 2+n_seg-1)
    for j in range(n_seg):
        phi = 2 * np.pi * j / n_seg
        vertices.append([r * np.cos(phi), r * np.sin(phi), -h])
    # Top ring (indices 2+n_seg .. 2+2*n_seg-1)
    for j in range(n_seg):
        phi = 2 * np.pi * j / n_seg
        vertices.append([r * np.cos(phi), r * np.sin(phi), h])

    bot = 2
    top = 2 + n_seg
    # Bottom cap
    for j in range(n_seg):
        indices.append([0, bot + (j + 1) % n_seg, bot + j])
    # Top cap
    for j in range(n_seg):
        indices.append([1, top + j, top + (j + 1) % n_seg])
    # Side
    for j in range(n_seg):
        b0, b1 = bot + j, bot + (j + 1) % n_seg
        t0, t1 = top + j, top + (j + 1) % n_seg
        indices.append([b0, b1, t1])
        indices.append([b0, t1, t0])

    return np.array(vertices, dtype=np.float64), np.array(indices, dtype=np.int32)


class MujocoMesh(RawMesh):
    def __init__(self, model, mesh_obj, rgba=None):
        vertices = model.mesh_vert[mesh_obj.vertadr[0]:mesh_obj.vertadr[0] + mesh_obj.vertnum[0]]
        indices = model.mesh_face[mesh_obj.faceadr[0]:mesh_obj.faceadr[0] + mesh_obj.facenum[0]]

        material = {}
        if rgba is not None:
            # Convert 0-1 float RGBA to 0-255 int for the JS frontend.
            color_255 = (np.clip(rgba, 0, 1) * 255).astype(int).tolist()
            material['color'] = color_255

        super().__init__(vertices, indices, [1, 1, 1], material)


class MujocoVisualizer:
    def __init__(self, model, data):
        self.model = model
        self.data = data
        self.mesh_names = []

    @staticmethod
    def from_xml_path(path):
        model = mujoco.MjModel.from_xml_path(path)
        data = mujoco.MjData(model)
        return MujocoVisualizer(model, data)

    def mesh_name(self, geom):
        if isinstance(geom, numbers.Number):
            geom = self.model.geom(geom)

        if geom.name:
            name = geom.name
        else:
            name = self.model.body(geom.bodyid[0]).name
        return f'{self.scene_prefix}{name}_{geom.id:d}'

    def populate_scene(self, scene, prefix=""):
        model = self.model

        self.scene = scene
        self.scene_prefix = prefix

        # Precompute per-geom data for fast update_scene().
        self._geom_body_ids = []
        self._geom_offset_t = []
        self._geom_offset_R = []
        self._geom_scene_keys = []

        for ig in range(model.ngeom):
            g = model.geom(ig)

            geom_type = int(g.type[0]) if hasattr(g.type, '__len__') else int(g.type)

            # mjtGeom: 0=plane, 2=sphere, 3=capsule, 5=cylinder, 6=box, 7=mesh
            if geom_type == 0:  # plane
                verts, faces = _make_plane_mesh(g.size)
                mesh = RawMesh(verts, faces, material=_rgba_material(g.rgba))
            elif geom_type == 7 and g.dataid[0] >= 0:
                mesh = MujocoMesh(model, model.mesh(g.dataid[0]), rgba=g.rgba)
            elif geom_type == 6:  # box
                verts, faces = _make_box_mesh(g.size)
                mesh = RawMesh(verts, faces, material=_rgba_material(g.rgba))
            elif geom_type == 2:  # sphere
                verts, faces = _make_sphere_mesh(g.size[0])
                mesh = RawMesh(verts, faces, material=_rgba_material(g.rgba))
            elif geom_type == 5:  # cylinder
                verts, faces = _make_cylinder_mesh(g.size[0], g.size[1])
                mesh = RawMesh(verts, faces, material=_rgba_material(g.rgba))
            else:
                continue

            # Store the transfrom from the body to geom on the mesh for later.
            mesh.offset = Pose(mj2pin(np.hstack([g.pos, g.quat])))

            mesh_name = self.mesh_name(g)
            self.mesh_names.append(mesh_name)

            scene.add(mesh_name, mesh)

            # Cache for update_scene: body id, offset (t, R), scene dict key.
            self._geom_body_ids.append(int(g.bodyid[0]))
            self._geom_offset_t.append(np.array(mesh.offset.t, dtype=np.float64))
            self._geom_offset_R.append(np.array(mesh.offset.R, dtype=np.float64))
            self._geom_scene_keys.append(mesh_name)

    def update_scene(self):
        data = self.data
        objs = self.scene.objs

        for i, body_id in enumerate(self._geom_body_ids):
            body = data.body(body_id)

            # Body pose: MuJoCo wxyz quat → rotation matrix (pure numpy).
            bR = _quat_wxyz_to_matrix(body.xquat)
            bt = body.xpos

            # Apply geom offset: mesh_pose = body_pose @ offset.
            ot = self._geom_offset_t[i]
            oR = self._geom_offset_R[i]
            t = bt + bR @ ot
            q = _matrix_to_quat_xyzw(bR @ oR)

            # Write directly to scene dict (skip update_pos overhead).
            objs[self._geom_scene_keys[i]]['pos'][:] = np.hstack([t, q])

    def init_scene(self, scene, prefix=""):
        self.step()
        self.populate_scene(scene, prefix)
        self.update_scene()

    def step(self):
        mujoco.mj_step(self.model, self.data)
