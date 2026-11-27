//! The site graph written over a corpus of its own: a shop walked twice.

use super::*;

/// The graph of a site walked twice is written beside its walks, once the corpus and the sites to graph are named, and
/// says what the drafted call is, for both walks.
#[test]
fn the_graph_of_a_shop_walked_twice_is_written_beside_its_walks() {
    let _offline = unbrowse_learn::http::offline();
    store::scratch_home("sitegraph-shop");
    let corpus = super::corpus::corpus_tests::a_shop_walked_twice();
    std::env::set_var("UNBROWSE_CORPUS", &corpus);
    std::env::set_var("UNBROWSE_GRAPH_SITES", "shop.example");
    the_graph_of_a_site_walked_twice();
    std::env::remove_var("UNBROWSE_GRAPH_SITES");
    let graph: Value = serde_json::from_str(&std::fs::read_to_string(corpus.join("shop.example.graph.json")).expect("the graph is written")).expect("a graph is JSON");
    assert_eq!(graph["walks"].as_array().map(Vec::len), Some(2), "one entry for each walk: {graph}");
    assert!(graph["walks"][0]["the_walk_did"].is_array() && graph["walks"][1]["storage_the_calls_read"].is_array(), "the layers a trace does not hold are laid on each walk: {graph}");
}
