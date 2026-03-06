import sys
if sys.prefix == '/home/kyber/miniconda3':
    sys.real_prefix = sys.prefix
    sys.prefix = sys.exec_prefix = '/home/kyber/dev/mim_data_utils/install/mim_data_utils'
