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

namespace mim_data_utils
{

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

} // End namespace.
