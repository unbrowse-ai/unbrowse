//! Behaviour of the finalized-chain checkpoints (`anchor`) that its own tests leave open: what a walk refuses, what a
//! head too far away does, and what the checkpoint store keeps.

use super::*;
use alloy::consensus::Header;

fn headers(n: u64, salt: u8) -> Vec<Header> {
    let mut out: Vec<Header> = Vec::new();
    for i in 0..n {
        let parent = out.last().map(|h| h.hash_slow()).unwrap_or_default();
        out.push(Header { number: i, parent_hash: parent, extra_data: vec![salt].into(), ..Default::default() });
    }
    out
}

/// A source that answers every ask by hash with the one header it holds, whatever hash was asked for.
struct Always(Header);

impl Headers for Always {
    async fn by_hash(&self, _hash: B256) -> Result<Option<Header>, String> {
        Ok(Some(self.0.clone()))
    }

    async fn by_numbers(&self, _low: u64, _high: u64) -> Result<Vec<Option<Header>>, String> {
        Err("no batches here".into())
    }
}

/// A source that holds nothing.
struct Empty;

impl Headers for Empty {
    async fn by_hash(&self, _hash: B256) -> Result<Option<Header>, String> {
        Ok(None)
    }

    async fn by_numbers(&self, _low: u64, _high: u64) -> Result<Vec<Option<Header>>, String> {
        Ok(vec![])
    }
}

#[tokio::test]
async fn a_walk_never_goes_up_or_further_than_it_may() {
    let h = headers(3, 1);
    let up = walk_down(&Empty, h[1].hash_slow(), 1, 2).await;
    assert_eq!(up, Err(Broken::Unanswered("block 2 is above 1".into())));
    let far = walk_down(&Empty, h[1].hash_slow(), MAX_LINK + 5, 4).await;
    assert!(matches!(&far, Err(Broken::Unanswered(e)) if e.contains("10001 blocks to link") && e.contains("10000")), "{far:?}");
    assert_eq!(walk_down(&Empty, h[1].hash_slow(), 1, 1).await, Ok(h[1].hash_slow()), "no distance, no ask");
}

#[tokio::test]
async fn a_header_the_rpc_has_not_yet_is_not_a_contradiction() {
    let h = headers(3, 1);
    let r = walk_down(&Empty, h[2].hash_slow(), 2, 0).await;
    assert!(matches!(&r, Err(Broken::Unanswered(e)) if e.contains("has no block")), "{r:?}");
}

#[tokio::test]
async fn a_header_that_does_not_hash_to_what_was_asked_for_contradicts_the_walk() {
    let real = headers(3, 1);
    let forged = headers(3, 2);
    // Asked for real[2] by hash, the source hands over a header of another chain.
    let r = walk_down(&Always(forged[2].clone()), real[2].hash_slow(), 2, 0).await;
    assert!(matches!(&r, Err(Broken::Contradicts(e)) if e.contains("hashes otherwise")), "{r:?}");
}

#[tokio::test]
async fn a_header_that_says_another_height_than_the_walk_expects_contradicts_it() {
    let real = headers(3, 1);
    // The walk believes real[2] sits at height 5: the header rehashes but names height 2.
    let r = walk_down(&Always(real[2].clone()), real[2].hash_slow(), 5, 3).await;
    assert!(matches!(&r, Err(Broken::Contradicts(e)) if e.contains("not 5") && e.contains("block 2")), "{r:?}");
}

#[test]
fn a_broken_link_reads_as_its_reason_and_turns_into_a_string() {
    assert_eq!(Broken::Unanswered("late".into()).to_string(), "late");
    assert_eq!(String::from(Broken::Contradicts("lied".into())), "lied");
}

#[tokio::test]
async fn a_head_too_far_from_the_last_checkpoint_starts_a_new_run_and_the_gap_is_not_anchored() {
    let real = headers(10, 1);
    let far = MAX_LINK + 100;
    let far_hash = B256::repeat_byte(7);
    let mut a = Anchored { chain_id: 1, ..Default::default() };
    assert!(extend(&mut a, 3, real[3].hash_slow(), Some(Witness::One), &Empty).await.unwrap());
    assert!(extend(&mut a, far, far_hash, Some(Witness::Second), &Empty).await.unwrap(), "taken without a walk it could not make");
    assert_eq!(a.runs.len(), 2, "a second run");
    assert_eq!(a.head(), Some((far, far_hash)));
    assert_eq!(a.agreed, vec![far], "only the head a second RPC agreed on is marked");
    // A block in the gap, between the runs, is on no walk.
    assert_eq!(anchored_at(&a, 500, B256::repeat_byte(1), &Empty).await, Ok(None));
}

#[tokio::test]
async fn a_head_at_or_below_the_last_checkpoint_is_not_taken_again() {
    let real = headers(10, 1);
    let mut a = Anchored { chain_id: 1, ..Default::default() };
    assert!(extend(&mut a, 5, real[5].hash_slow(), Some(Witness::One), &Empty).await.unwrap());
    assert!(!extend(&mut a, 5, real[5].hash_slow(), Some(Witness::Second), &Empty).await.unwrap(), "the same head");
    assert!(!extend(&mut a, 4, real[4].hash_slow(), Some(Witness::Second), &Empty).await.unwrap(), "an older head");
    assert_eq!(a.runs, vec![vec![(5, real[5].hash_slow())]]);
    assert!(a.agreed.is_empty(), "nothing was marked by the heads not taken");
}

#[tokio::test]
async fn the_oldest_checkpoints_go_first_and_take_their_agreement_marks_with_them() {
    let mut run: Vec<(u64, B256)> = (0..MAX_CHECKPOINTS as u64).map(|n| (n, B256::repeat_byte(1))).collect();
    run[0].0 = 0;
    let mut a = Anchored { chain_id: 1, runs: vec![run], agreed: vec![0, 1, 100] };
    // One more, too far from the last to link: a new run of one, and the store is a checkpoint over its bound.
    let far = MAX_CHECKPOINTS as u64 + MAX_LINK + 10;
    assert!(extend(&mut a, far, B256::repeat_byte(2), Some(Witness::One), &Empty).await.unwrap());
    let total: usize = a.runs.iter().map(Vec::len).sum();
    assert_eq!(total, MAX_CHECKPOINTS, "back to the bound");
    assert_eq!(a.runs[0].first().map(|c| c.0), Some(1), "the oldest went");
    assert_eq!(a.agreed, vec![1, 100], "a mark for a checkpoint that went goes too");
}

#[tokio::test]
async fn a_run_emptied_by_pruning_leaves_the_store() {
    let mut a = Anchored { chain_id: 1, runs: vec![vec![(0, B256::repeat_byte(1))], (1..MAX_CHECKPOINTS as u64).map(|n| (n, B256::repeat_byte(1))).collect()], agreed: vec![] };
    let far = MAX_CHECKPOINTS as u64 + MAX_LINK + 10;
    assert!(extend(&mut a, far, B256::repeat_byte(2), Some(Witness::One), &Empty).await.unwrap());
    assert_eq!(a.runs.len(), 2, "the one-checkpoint run is gone, the other and the new one stay");
    assert_eq!(a.runs[0].first().map(|c| c.0), Some(1));
}

#[tokio::test]
async fn a_block_below_every_run_or_beyond_every_checkpoint_is_on_no_walk() {
    let real = headers(40, 1);
    let src = Always(real[0].clone());
    let a = Anchored { chain_id: 1, runs: vec![vec![(10, real[10].hash_slow())]], agreed: vec![] };
    assert_eq!(anchored_at(&a, 5, real[5].hash_slow(), &src).await, Ok(None), "below the run");
    assert_eq!(anchored_at(&a, 11, real[11].hash_slow(), &src).await, Ok(None), "above its last checkpoint");
    assert_eq!(anchored_at(&Anchored::default(), 1, B256::ZERO, &src).await, Ok(None), "nothing followed");
    let empty_run = Anchored { chain_id: 1, runs: vec![vec![]], agreed: vec![] };
    assert_eq!(anchored_at(&empty_run, 1, B256::ZERO, &src).await, Ok(None), "an empty run has no start");
}

#[test]
fn a_second_rpcs_finality_is_near_enough_within_the_skew_either_way() {
    assert!(fresh_for_second(1000, 1000 + HEAD_SKEW));
    assert!(fresh_for_second(1000 + HEAD_SKEW, 1000));
    assert!(!fresh_for_second(1000, 1000 + HEAD_SKEW + 1));
    assert!(!fresh_for_second(1000 + HEAD_SKEW + 1, 1000));
    assert!(Witness::Second.agrees() && Witness::Here.agrees() && !Witness::One.agrees());
}
