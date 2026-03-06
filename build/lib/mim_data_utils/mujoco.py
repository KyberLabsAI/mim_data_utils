import numpy as np
import mujoco
import numbers
from scipy.spatial.transform import Rotation

from .scene import RawMesh
from .scene import mj2pin
from .scene import Pose




class MujocoMesh(RawMesh):
    def __init__(self, model, mesh_obj):
        vertices = model.mesh_vert[mesh_obj.vertadr[0]:mesh_obj.vertadr[0] + mesh_obj.vertnum[0]]
        indices = model.mesh_face[mesh_obj.faceadr[0]:mesh_obj.faceadr[0] + mesh_obj.facenum[0]]

        super().__init__(vertices, indices, [1, 1, 1], {})


class MujocoVisualizer:
    def __init__(self, model, data):
        self.model = model
        self.data = data
        self.mesh_names = []

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

        for ig in range(model.ngeom):
            g = model.geom(ig)

            # Ignore geometries without meshes.
            if g.dataid < 0:
                continue

            mesh = MujocoMesh(model, model.mesh(g.dataid[0]))

            # Store the transfrom from the body to geom on the mesh for later.
            mesh.offset = Pose(mj2pin(np.hstack([g.pos, g.quat])))

            mesh_name = self.mesh_name(g)
            self.mesh_names.append(mesh_name)

            scene.add(mesh_name, mesh)

    def update_scene(self):
        model = self.model
        scene = self.scene

        for ig in range(model.ngeom):
            g = model.geom(ig)
            if g.dataid < 0:
                continue

            name = self.mesh_name(g)

            body = self.data.body(g.bodyid[0])
            body_pos = Pose(mj2pin(np.hstack([body.xpos, body.xquat])))
            mesh_pos = body_pos.apply(scene.object(name).offset)

            scene.update_pos(name, mesh_pos)

    def init_scene(self, scene, prefix=""):
        self.step()
        self.populate_scene(scene, prefix)
        self.update_scene()

    def step(self):
        mujoco.mj_step(self.model, self.data)
