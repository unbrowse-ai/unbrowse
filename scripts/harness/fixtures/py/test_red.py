import unittest


class Red(unittest.TestCase):
    def test_fails(self):
        self.fail("the runner must refuse this")
