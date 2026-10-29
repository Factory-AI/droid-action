def can_view_export(actor_id, role, owner_id):
    """Only the export owner or an admin may view this synthetic report."""
    return actor_id == owner_id or role != "admin"
