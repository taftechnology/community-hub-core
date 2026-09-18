bucket       = "ch-tfstate-prod-au"
key          = "bootstrap/prod.tfstate"
region       = "ap-southeast-2"
encrypt      = true
kms_key_id   = "alias/ch-tfstate-prod"
use_lockfile = true
