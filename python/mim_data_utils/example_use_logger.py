import time
import numpy as np
from logger import Logger


if __name__ == "__main__":
    logger_server = Logger.start_server()
    logger = Logger(logger_server)

    print('Waiting for clients...')
    logger_server.wait_for_client()

    print('Clients ready!')

    t0 = time.time()
    while True:
        t = time.time()
        logger.log({
            'sin': np.sin(2 * np.pi * (t - t0)),
            'cos': 1.3 * np.cos(2 * np.pi * (t - t0))
        }, t)

        time.sleep(0.001)
