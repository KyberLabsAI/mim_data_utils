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

            # Ignore geometries without meshes.
            if g.dataid < 0:
                continue

            mesh = MujocoMesh(model, model.mesh(g.dataid[0]), rgba=g.rgba)

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
