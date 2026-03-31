#!/usr/bin/env python3
"""
run_tests.py — Run the State of Finance test suite and print a detailed report.

Usage:
    python run_tests.py
"""

import os
import sys
import unittest


def main():
    start_dir = os.path.dirname(os.path.abspath(__file__))

    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=start_dir, pattern='test_app.py')

    # verbosity=2 prints each test name with ok / FAIL / ERROR
    runner = unittest.TextTestRunner(verbosity=2, stream=sys.stdout)
    result = runner.run(suite)

    total  = result.testsRun
    n_fail = len(result.failures)
    n_err  = len(result.errors)
    n_pass = total - n_fail - n_err
    pct    = (n_pass / total * 100) if total else 0.0

    print()
    print('=' * 70)
    print(f'  TOTAL   : {total} tests')
    print(f'  PASSED  : {n_pass}  ({pct:.1f}%)')

    if n_fail:
        print(f'  FAILED  : {n_fail}')
        for test, traceback in result.failures:
            # Print just the first line of the traceback for quick scanning
            first_line = traceback.strip().splitlines()[-1]
            print(f'    ✗ {test}')
            print(f'      {first_line}')

    if n_err:
        print(f'  ERRORS  : {n_err}')
        for test, traceback in result.errors:
            first_line = traceback.strip().splitlines()[-1]
            print(f'    ✗ {test}')
            print(f'      {first_line}')

    if result.wasSuccessful():
        print('  STATUS  : ALL TESTS PASSED ✓')
    else:
        print('  STATUS  : SOME TESTS FAILED ✗')

    print('=' * 70)

    sys.exit(0 if result.wasSuccessful() else 1)


if __name__ == '__main__':
    main()
