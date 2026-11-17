//! Runs the test shop so a flow can be recorded by hand: `cargo run -p unbrowse-learn --example shop`.
#[path = "../tests/common/shop.rs"]
mod shop;

fn main() {
    println!("{}", shop::start());
    std::thread::park();
}
