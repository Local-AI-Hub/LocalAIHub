import os
import runpy
import sys


def main():
    if len(sys.argv) < 4:
        raise RuntimeError('NestAI could not determine which Python target to launch.')

    working_directory = sys.argv[1]
    launch_mode = sys.argv[2]
    target = sys.argv[3]
    forwarded_args = sys.argv[4:]

    os.chdir(working_directory)
    normalized_working_directory = os.path.abspath(working_directory)
    if normalized_working_directory not in sys.path:
        sys.path.insert(0, normalized_working_directory)

    sys.argv = [target] + forwarded_args

    if launch_mode == 'module':
        runpy.run_module(target, run_name='__main__')
        return

    runpy.run_path(os.path.abspath(target), run_name='__main__')


if __name__ == '__main__':
    main()
