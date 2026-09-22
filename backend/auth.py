"""auth.py — hashing de senha e verificação de credenciais (server-side)."""

import hashlib
import os

import db


def random_salt():
    return os.urandom(16).hex()


def hash_password(password, salt):
    return hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()


def create_user(full_name, username, password, role="tecnico"):
    if db.get_user_by_username(username):
        raise ValueError("Já existe um usuário com este nome de usuário.")
    salt = random_salt()
    pw_hash = hash_password(password, salt)
    return db.create_user(full_name, username, role, salt, pw_hash)


def verify_credentials(username, password):
    user = db.get_user_by_username(username)
    if not user:
        return None
    if hash_password(password, user["salt"]) == user["passwordHash"]:
        return user
    return None


def change_password(user_id, new_password):
    salt = random_salt()
    pw_hash = hash_password(new_password, salt)
    db.update_user_password(user_id, salt, pw_hash)


def public_user(user):
    return {k: v for k, v in user.items() if k not in ("salt", "passwordHash")}
