#include <stdio.h>
#include <string.h>
#include <assert.h>
#include <iostream>
#include <vector>
#include <cstring>
#include <fstream>
#include <iostream>

#include "zlib.h"
#include <Eigen/Dense>

// Resouces:
// - https://gist.github.com/arq5x/5315739
// - http://www.zlib.net/zlib_how.html

// Maimum number of fields the DataLogger can hold.
#define MAX_FIELDS 1024

// 256 kb
#define CHUNK_SIZE 256000

namespace mim_data_utils {

struct FieldDefinition
{
    unsigned char name[64];
    int size;
};

class DataLogger
{
public:
    DataLogger(std::string filepath);

    int AddField(std::string field_name, int field_size);

    void InitFile();

    void CloseFile();

    void BeginTimestep();

    void Log(int field_id, Eigen::Ref<Eigen::VectorXd> value);

    void EndTimestep();

protected:
    void WriteHeader();

    std::vector<FieldDefinition> fields;
    gzFile file;

    bool wrote_head;

    unsigned char zlib_buffer[CHUNK_SIZE];
    unsigned char output_buffer[CHUNK_SIZE];
    z_stream zlib_strm;
};

DataLogger::DataLogger(std::string filepath)
: wrote_head(false)
{
    int ret;

    file = gzopen(filepath.c_str(), "w");

    // Preallocate to be realtime safe later on.
    fields.reserve(MAX_FIELDS);

    zlib_strm.zalloc = Z_NULL;
    zlib_strm.zfree = Z_NULL;
    zlib_strm.opaque = Z_NULL;
    ret = deflateInit(&zlib_strm, Z_BEST_COMPRESSION);

    if (ret == Z_STREAM_ERROR) {
        throw std::runtime_error("Error initializing zlib compression.");
    }
}

void DataLogger::WriteHeader()
{
    int ret;
    unsigned have;
    uInt chunck_size = (uInt)sizeof(zlib_buffer);

    wrote_head = true;

    // Write the header.
    unsigned int header[2] = {0, fields.size()};
    gzwrite(file, (const char *)&header, sizeof(header));

    // Write the file data.
    gzwrite(file, (const char *)fields.data(), sizeof(FieldDefinition) * fields.size());
}

int DataLogger::AddField(std::string field_name, int field_size)
{
    FieldDefinition field;

    // Initialize the char array with zeros.
    for (int i = 0; i < 64; i++) {
        field.name[i] = 0;
    }

    // Copy over the string array one char at a time.
    // TODO: There should be a better way for this?
    for (int i = 0; i < 64; i++) {
        field.name[i] = field_name.c_str()[i];
        if (field.name[i] == 0) {
            break;
        }
    }
    field.size = field_size;
    fields.push_back(field);
    return fields.size() - 1;
}

void DataLogger::BeginTimestep()
{
    if (!wrote_head) {
        WriteHeader();
    }
}

void DataLogger::Log(int field_id, Eigen::Ref<Eigen::VectorXd> value)
{
    int field_size = fields[field_id].size;
    if (field_size != value.size()) {
        throw std::runtime_error("Field has other size as previously defined.");
    }

    float* chunck_ptr = (float*)&output_buffer;
    int field_offset = 0;
    for (int i = 0; i < field_id; i++) {
        field_offset += fields[i].size;
    }

    // Copy the value one entry at a time into the buffer.
    // TODO: Is there a better way to do this?
    for (int i = 0; i < field_size; i++) {
        chunck_ptr[field_offset + i] = value(i);
    }
}

void DataLogger::EndTimestep()
{
    int ret;
    unsigned have;
    uInt chunck_size = (uInt)sizeof(zlib_buffer);

    int total_field_size = 0;
    for (int i = 0; i < fields.size(); i++) {
        total_field_size += fields[i].size;
    }

    gzwrite(file, (const char *)&output_buffer, sizeof(float) * total_field_size);
}

void DataLogger::CloseFile()
{
    (void)deflateEnd(&zlib_strm);
    gzclose(file);
}


} // namespace mim_data_util

int main()
{
    mim_data_utils::DataLogger dl("output.mds");
    int fld_jp = dl.AddField("joint_positions", 4);
    int fld_jv = dl.AddField("joint_velocities", 6);
    int fld_sp = dl.AddField("slider_positions", 2);

    dl.BeginTimestep();

    Eigen::VectorXd joint_positions(4);
    joint_positions << 1., 2., 3., 4.;

    Eigen::VectorXd joint_velocities(6);
    joint_velocities << 5., 6., 7., 8., 9., 10.;

    Eigen::VectorXd slider_positions(2);
    slider_positions << 11., 12.;

    dl.Log(fld_jp, joint_positions);
    dl.Log(fld_jv, joint_velocities);
    dl.Log(fld_sp, slider_positions);

    dl.EndTimestep();
    dl.CloseFile();
}
