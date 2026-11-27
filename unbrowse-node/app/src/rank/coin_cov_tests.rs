//! Rank's coin side beyond its own tests: a weight with nothing to weigh, the draw's range, and the entry that was
//! explored and then demoted.

use super::*;

fn id(n: u8) -> B256 {
    B256::repeat_byte(n)
}

#[test]
fn a_delay_weight_against_no_median_and_no_delay_counts_for_nothing() {
    assert_eq!(exit_delay_weight_against(0, 0), 0.0, "nothing over nothing is not NaN");
    assert_eq!(exit_delay_weight_against(100, 0), 1.0, "any delay against no median is all of it");
    assert_eq!(exit_delay_weight_against(0, 100), 0.0);
}

#[test]
fn a_draw_is_a_number_below_one_and_not_always_the_same() {
    let draws: Vec<f64> = (0..64).map(|_| draw()).collect();
    assert!(draws.iter().all(|d| (0.0..1.0).contains(d)), "{draws:?}");
    assert!(draws.windows(2).any(|w| w[0] != w[1]), "randomness, not a constant");
}

#[test]
fn an_entry_explored_and_then_demoted_goes_last_and_is_not_said_to_be_explored() {
    let (ranked, fresh) = (id(1), id(2));
    let ranks: HashMap<B256, f64> = [(ranked, 5.0)].into();
    let mut none = || 0.0;
    let p = order(&ranks, vec![fresh, ranked], |e| *e, true, (0.0, 0.0, &mut none), |_| false);
    assert_eq!((p.order.clone(), p.explored), (vec![fresh, ranked], Some(fresh)), "undemoted, the unranked entry is explored first");
    let mut none = || 0.0;
    let p = order(&ranks, vec![fresh, ranked], |e| *e, true, (0.0, 0.0, &mut none), |e| e == fresh);
    assert_eq!(p.order, vec![ranked, fresh], "demoted, it goes last");
    assert_eq!(p.explored, None, "and what failed here is not what was tried to learn");
}
