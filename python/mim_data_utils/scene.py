import numpy as np
import meshio
from scipy.spatial.transform import Rotation

def mj2pin(x):
    if len(x) == 4:
        # Sometimes mujoco has a full-zero quaternion.
        if np.allclose(x, np.zeros(4)):
            res = np.array([0, 0, 0, 1])
        else:
            res = np.hstack([x[1:4], x[0]])
    else:
        res = np.array(x)
        res[3:] = mj2pin(x[3:])

    return res



class Pose:
    def __init__(self, x, R=None):
        if R is None:
            self.t = x[:3]
            self.R = Rotation.from_quat(x[3:]).as_matrix()
        else:
            self.t = x
            self.R = R

    def apply(self, other):
        t = self.t + self.R @ other.t
        R = self.R @ other.R

        return Pose(t, R)

    def trans(self):
        return self.t

    def quat(self):
        return Rotation.from_matrix(self.R).as_quat()


class RawMesh:
    def __init__(self, vertices, indices, scale=None, material=None):
        if scale is None:
            scale = [1, 1, 1]

        if material is None:
            material = {}

        self.scale = scale
        self.material = material

        # Frontend expects flattened list.
        self.vertices = np.array(vertices).reshape(-1)
        self.indices = np.array(indices).reshape(-1)


    def set_color(self, color):
        self.material['color'] = color

    def to_log_dict(self, name):
        return {
            'name': name,
            'type': '3dMesh',
            'vertices': self.vertices,
            'indices': self.indices,
            'scale': self.scale,
            'material': self.material
        }


class Mesh(RawMesh):
    def __init__(self, path, scale=None, material=None):
        self.data = mesh = meshio.read(path)

        super().__init__(mesh.points, mesh.cells_dict['triangle'], scale, material)

def parse_color_str(color):
    val = int(color, 16)
    if len(color) == 6:
        return [
            (val >> 16) & 0xff,
            (val >> 8) & 0xff,
            (val >> 0) & 0xff,
            255
        ]
    elif len(color) == 8:
        return [
            (val >> 24) & 0xff,
            (val >> 16) & 0xff,
            (val >> 8) & 0xff,
            (val >> 0) & 0xff
        ]
    else:
        raise "Not able to parse color string: " + color


class Scene:
    def __init__(self):
        self.objs = {}

    def add(self, name, obj, pos=None):
        self.objs[name] = {
            'object': obj,
            'pos': np.array([0., 0., 0., 0., 0., 0., 1.])
        }

        if pos is not None:
            self.update_pos(name, pos)

    def entries(self):
        return self.objs

    def objects(self):
        res = []
        for entry in self.objs.values():
            res.append(entry['object'])
        return res

    def object(self, name):
        return self.objs[name]['object']

    def to_static_dict(self):
        res = {}

        for key, value in self.objs.items():
            res['3d/' + key] = value['object']

        return res

    def update_color(self, name, color):
        if isinstance(color, str):
            color = parse_color_str(color)
        elif len(color) == 3:
            color = np.hstack((color, 255))
        elif len(color) != 4:
            assert False, "Color needs to be 3- or 4-dim array (values 0..255 rgba) or hex string (rgb, rgba)"
        self.objs[name]['color'] = color

    def update_pos(self, name, x, mujoco=False):
        # Duck typing for pose object.
        if hasattr(x, 'as_state'):
            state = x.as_state()
            trans = state[:3]
            quat = state[3:]
        else:
            x = np.asarray(x)
            if x.shape[0] == 7 and not mujoco:
                self.objs[name]['pos'][:] = x
                return
            elif np.all(np.array(x.shape) == np.array([4, 4])):
                trans = x[:3, 3]
                quat = Rotation.from_matrix(x[:3, :3]).as_quat()
            elif x.shape[0] == 7:
                if mujoco:
                    x = mj2pin(x)
                trans = x[:3]
                quat = x[3:]
            elif x.shape[0] == 6:
                trans = x[:3]
                quat = Rotation.from_euler('xyz', x[3:]).as_quat()
            elif x.shape[0] == 3:
                trans = x
                quat = np.array([0, 0, 0, 1])
            else:
                raise RuntimeError("Shape of x not supported")

        self.objs[name]['pos'] = np.hstack([trans, quat])

    def to_log_dict(self):
        res = {}

        for key, value in self.objs.items():
            res['3d/' + key + '/pos'] = value['pos']

            if 'color' in value:
                res['3d/' + key + '/color'] = value['color']

        return res

