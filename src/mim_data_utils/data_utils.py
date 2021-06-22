import struct
import array
import gzip

import numpy as np

data_type = np.float32
data_type_letter = 'f'
data_size = 4

# data_type = np.double
# data_type_letter = 'd'
# data_size = 8

class DataLogger:
    def __init__(self, filepath):
        self.filepath = filepath
        self.fh = None
        self.fields = []
        self.field_data = []
        self.file_index = -1

    def add_field(self, field_name, field_size):
        assert field_size > 0, 'Field size must be positive'
        assert type(field_size) == int, 'Expecting integer'
        assert self.fh is None, 'Cannot add field once logging started'

        self.fields.append((field_name, field_size))
        self.field_data.append(np.zeros(field_size, data_type))
        return len(self.fields) - 1

    def init_file(self):
        self.fh = gzip.open(self.filepath, "wb+")

        # Write the header.
        arr = array.array('I', [0, len(self.fields)])
        self.fh.write(arr.tobytes())

        for (name, size) in self.fields:
            byt = struct.pack("64s I", name.encode('utf8'), size)
            self.fh.write(byt)

    def close_file(self):
        assert self.fh, 'File is not open'
        self.fh.close()

    def begin_timestep(self):
        if self.fh is None:
            self.init_file()

        self.file_index += 1

        # Negative seek not supported by gzip.
        # self.fh.seek(0, 0) # Beginning of the file.
        # self.fh.write(struct.pack('I', self.file_index))
        #
        # self.fh.seek(0, 2) # End of the file.

    def log_array(self, field_id, value):
        self.field_data[field_id][:] = value

    def log_int(self, field_id, value):
        self.field_data[field_id][0] = float(value)

    def log_float(self, field_id, value):
        self.field_data[field_id][0] = value

    def end_timestep(self):
        # Write the recorded field_data to the file.
        for value in self.field_data:
            self.fh.write(value.tobytes())

        # self.fh.flush()


class DataReader:
    def __init__(self, filepath, read_data=True):
        self.filepath = filepath
        self.fh = gzip.open(self.filepath, 'rb+')

        self.fields = []
        self.data = {}
        self.tmp_data = {}

        self.read_header()
        self.read_fields()

        if read_data:
            self.read_data()

    def read_header(self):
        byt = self.fh.read(8)
        self.idx, self.num_fields = struct.unpack('II', byt)

        print('idx:', self.idx, 'fields:', self.num_fields)


    def read_fields(self):
        self.chunck_size = 0
        for _ in range(self.num_fields):
            byt = self.fh.read(64 + 4)
            name, size = struct.unpack("64s I", byt)
            name = name.decode('utf8').rstrip('\x00')
            self.fields.append((name, size))
            self.tmp_data[name] = []

            self.chunck_size += size * data_size

        print(self.fields)

    def read_chunck(self, chunck_idx, data={}):
        """Reads a single chunck of data and returns it."""
        fh = self.fh

        # Compute the address for the data chunck.
        pos = 8 + (64 + 4) * self.num_fields # Header + field info
        pos += self.chunck_size * chunck_idx

        fh.seek(pos, 0)

        for (field_name, field_size) in self.fields:
            arr = array.array(data_type_letter)
            arr.frombytes(fh.read(data_size * field_size))
            data[field_name] = arr

        return data

    def read_data(self):
        """Reads all the data and stores it in self.data."""

        fh = self.fh

        # Move to the begining of the data section in the file.
        fh.seek(8 + (64 + 4) * self.num_fields)

        # Read all the entires.
        idx = 0
        N_fields = len(self.fields)
        data = fh.read(data_size * self.fields[0][1])
        while data:
            for i, (field_name, field_size) in enumerate(self.fields):
                arr = array.array(data_type_letter)
                arr.frombytes(data)
                self.tmp_data[field_name].append(arr)
                data = fh.read(data_size * self.fields[(i + 1) % N_fields][1])
            idx += 1

        # Convert the arrays in `tmp_data` to numpy arrays and store them on
        # data.
        for i, (field_name, field_size) in enumerate(self.fields):
            self.data[field_name] = np.array(self.tmp_data[field_name])
