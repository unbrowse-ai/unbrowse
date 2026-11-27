//! The pass-rate pick beyond its own tests: an entry that was explored and then demoted.

use super::*;

fn id(n: u8) -> B256 {
    B256::repeat_byte(n)
}

#[test]
fn an_unverified_entry_explored_and_then_demoted_goes_last_and_is_not_said_to_be_explored() {
    let (known, new) = (id(1), id(2));
    let who = Address::repeat_byte(9);
    let standing = Standing {
        entry: known,
        contributor: who,
        fee: 0.01,
        live: true,
        counted_uses: 5,
        passes: 5.0,
        fails: 0.0,
        pass_rate: rate(5.0, 0.0),
        default: true,
        unverified: false,
        listed_at: (1, 1),
    };
    let st = Standings { epoch: 3, routes: vec![Route { site: "shop.example".into(), what: "search".into(), default: Some(known), entries: vec![standing] }], by_entry: [(known, (0, 0))].into(), contributors: HashMap::new() };
    let of = |e: &B256| Candidate { entry: *e, contributor: who, site: "shop.example".into(), fee: 0.01 };
    let p = order(&st, vec![known, new], of, true, (0.0, 0.0), |_| false);
    assert_eq!((p.order.clone(), p.explored), (vec![new, known], Some(new)), "undemoted, the entry the chain doesn't show yet is explored first");
    let p = order(&st, vec![known, new], of, true, (0.0, 0.0), |e| e == new);
    assert_eq!(p.order, vec![known, new], "demoted, it goes last");
    assert_eq!(p.explored, None);
}
