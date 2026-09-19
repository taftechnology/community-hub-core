CREATE TABLE app.people (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  display_name text NOT NULL
);

ALTER TABLE app.people ENABLE ROW LEVEL SECURITY;
