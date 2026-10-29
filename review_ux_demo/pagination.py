def page(rows, page_index, page_size):
    """Zero-based pages contain at most page_size rows."""
    start = page_index * page_size
    return rows[start : start + page_size + 1]
