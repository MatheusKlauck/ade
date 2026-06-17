/// Append a new card after the current max position.
/// First card gets 1024.0.
pub fn append_position(max_pos: Option<f64>) -> f64 {
    match max_pos {
        Some(m) => m + 1024.0,
        None => 1024.0,
    }
}

/// Insert between two existing positions.
pub fn insert_between(a: f64, b: f64) -> f64 {
    (a + b) / 2.0
}

/// Returns true if any adjacent gap is below 1e-6.
pub fn needs_rebalance(cards: &[f64]) -> bool {
    if cards.len() < 2 {
        return false;
    }
    for w in cards.windows(2) {
        if w[1] - w[0] < 1e-6 {
            return true;
        }
    }
    false
}

/// Rebalance cards preserving order.
/// Input is [(card_id, position)] sorted by position.
/// Output is [(card_id, new_position)] with new_position = 1024.0 * (i + 1).
pub fn rebalance(cards: &[(String, f64)]) -> Vec<(String, f64)> {
    let mut sorted = cards.to_vec();
    sorted.sort_by(|a, b| a.1.total_cmp(&b.1));
    sorted
        .into_iter()
        .enumerate()
        .map(|(i, (id, _))| (id, 1024.0 * (i as f64 + 1.0)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_first() {
        assert_eq!(append_position(None), 1024.0);
    }

    #[test]
    fn append_after() {
        assert_eq!(append_position(Some(1024.0)), 2048.0);
    }

    #[test]
    fn insert_between_basic() {
        assert_eq!(insert_between(1024.0, 2048.0), 1536.0);
    }

    #[test]
    fn needs_rebalance_false_when_gaps_ok() {
        let cards = vec![1024.0, 2048.0, 3072.0];
        assert!(!needs_rebalance(&cards));
    }

    #[test]
    fn needs_rebalance_true_when_tight() {
        let cards = vec![1024.0, 1024.0 + 0.5e-6];
        assert!(needs_rebalance(&cards));
    }

    #[test]
    fn rebalance_preserves_order() {
        let cards = vec![("a".into(), 100.0), ("b".into(), 200.0), ("c".into(), 50.0)];
        let result = rebalance(&cards);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].0, "c");
        assert_eq!(result[0].1, 1024.0);
        assert_eq!(result[1].0, "a");
        assert_eq!(result[1].1, 2048.0);
        assert_eq!(result[2].0, "b");
        assert_eq!(result[2].1, 3072.0);
    }

    #[test]
    fn rebalance_does_not_panic_on_nan() {
        let cards = vec![("a".into(), 100.0), ("b".into(), f64::NAN)];
        let result = rebalance(&cards);
        assert_eq!(result.len(), 2);
    }
}
