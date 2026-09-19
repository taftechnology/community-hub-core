UPDATE app.communities SET name = 'x' WHERE id = 'y';
INSERT INTO app.communities (id) VALUES ('x')
  ON CONFLICT (id) DO UPDATE SET updated_at = now();
