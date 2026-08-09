import functools


def make_rule(path):
    return "/scoped" + path


def require_admin(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)

    return wrapper
