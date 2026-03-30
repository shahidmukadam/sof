from app import app, init_db, migrate_db


init_db()
migrate_db()

application = app
