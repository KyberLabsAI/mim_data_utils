import mim_data_utils as mds

if __name__ == "__main__":
    ds = mds.DataReader('output.mds')
    print(ds.data)
