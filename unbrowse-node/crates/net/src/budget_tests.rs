//! The bounds on what a node remembers about its peers: the payers it ranks and the turns it keeps.

use super::*;

fn at(base: Instant, ms: u64) -> Instant {
    base + Duration::from_millis(ms)
}

#[test]
fn a_full_list_of_payers_drops_the_one_whose_last_payment_is_oldest() {
    let base = Instant::now();
    let mut payers = Payers::default();
    let first = PeerId::random();
    payers.paid(first, base);
    let others: Vec<PeerId> = (1..MAX_PAYERS).map(|_| PeerId::random()).collect();
    for (i, p) in others.iter().enumerate() {
        payers.paid(*p, at(base, i as u64 + 1));
    }
    let newest = PeerId::random();
    payers.paid(newest, at(base, 5000));
    let now = at(base, 6000);
    assert_eq!(payers.rank(&first, now), 0, "the oldest payment makes room");
    assert_eq!(payers.rank(&others[0], now), 1);
    assert_eq!(payers.rank(&newest, now), 1);
    assert_eq!(payers.paid.len(), MAX_PAYERS);
}

#[test]
fn payers_whose_payments_are_an_hour_old_are_forgotten_to_make_room_before_any_is_dropped() {
    let base = Instant::now();
    let mut payers = Payers::default();
    let old: Vec<PeerId> = (0..MAX_PAYERS).map(|_| PeerId::random()).collect();
    for p in &old {
        payers.paid(*p, base);
    }
    let late = at(base, PAID_FOR.as_millis() as u64 + 1);
    let fresh = PeerId::random();
    payers.paid(fresh, late);
    assert_eq!(payers.paid.len(), 1, "every older payer lapsed and went");
    assert_eq!(payers.rank(&fresh, late), 1);
    assert_eq!(payers.rank(&old[0], late), 0);
}

#[test]
fn one_peers_payments_are_kept_to_the_most_recent_few_hundred() {
    let base = Instant::now();
    let mut payers = Payers::default();
    let peer = PeerId::random();
    for i in 0..MAX_PAID_TIMES as u64 + 40 {
        payers.paid(peer, at(base, i));
    }
    assert_eq!(payers.rank(&peer, at(base, 1000)), MAX_PAID_TIMES as u32);
}

#[test]
fn a_hundred_thousand_newcomers_leave_no_more_turns_than_the_bound_remembers() {
    let base = Instant::now();
    let mut slots: Slots<u32> = Slots::new(2, 4);
    // One shared slot taken for good, so every later ask by a stranger to the payers takes the newcomer's.
    let Asked::Now(_, _) = slots.ask(PeerId::random(), 0, base, |_| 1) else { panic!("a free slot") };
    let mut last = None;
    for i in 0..MAX_PAYERS as u64 + 2 {
        let peer = PeerId::random();
        let Asked::Now(slot, _) = slots.ask(peer, 0, at(base, i), |_| 0) else { panic!("the newcomer's slot is free in turn") };
        assert!(slot.newcomer);
        assert!(slots.done(slot, at(base, i), |_| 0).is_none());
        last = Some(peer);
    }
    assert!(slots.turns.len() <= MAX_PAYERS, "{} turns kept", slots.turns.len());
    assert!(slots.turns.contains_key(&last.unwrap()), "the newest turn is kept");
}

#[test]
fn a_gated_behaviour_lets_its_inner_one_be_changed_through_it() {
    let mut gated = Gated::new(vec![1u8], KadGate::new());
    gated.push(2);
    assert_eq!(*gated.inner, vec![1, 2]);
    assert_eq!(gated.len(), 2, "reads go through to it too");
}
