//! Antithesis assertions for the harness in `antithesis/` (see its scratchbook's property catalog), compiled in only
//! with the `antithesis` feature. Each macro takes the SDK macro's own arguments: with the feature it is that macro,
//! and without it it is nothing at all, so a normal build carries no SDK and never builds an assertion's details.
//! The message is a string literal at every call site, as the SDK's catalog needs, and names its property.

#![allow(unused_macros)]

#[cfg(feature = "antithesis")]
macro_rules! sut_always {
    ($($t:tt)*) => {
        antithesis_sdk::assert_always!($($t)*)
    };
}
#[cfg(not(feature = "antithesis"))]
macro_rules! sut_always {
    ($($t:tt)*) => {};
}

#[cfg(feature = "antithesis")]
macro_rules! sut_always_or_unreachable {
    ($($t:tt)*) => {
        antithesis_sdk::assert_always_or_unreachable!($($t)*)
    };
}
#[cfg(not(feature = "antithesis"))]
macro_rules! sut_always_or_unreachable {
    ($($t:tt)*) => {};
}

#[cfg(feature = "antithesis")]
macro_rules! sut_sometimes {
    ($($t:tt)*) => {
        antithesis_sdk::assert_sometimes!($($t)*)
    };
}
#[cfg(not(feature = "antithesis"))]
macro_rules! sut_sometimes {
    ($($t:tt)*) => {};
}

#[cfg(feature = "antithesis")]
macro_rules! sut_reachable {
    ($($t:tt)*) => {
        antithesis_sdk::assert_reachable!($($t)*)
    };
}
#[cfg(not(feature = "antithesis"))]
macro_rules! sut_reachable {
    ($($t:tt)*) => {};
}

#[cfg(feature = "antithesis")]
macro_rules! sut_unreachable {
    ($($t:tt)*) => {
        antithesis_sdk::assert_unreachable!($($t)*)
    };
}
#[cfg(not(feature = "antithesis"))]
macro_rules! sut_unreachable {
    ($($t:tt)*) => {};
}

#[cfg(feature = "antithesis")]
macro_rules! sut_always_less_than_or_equal_to {
    ($($t:tt)*) => {
        antithesis_sdk::assert_always_less_than_or_equal_to!($($t)*)
    };
}
#[cfg(not(feature = "antithesis"))]
macro_rules! sut_always_less_than_or_equal_to {
    ($($t:tt)*) => {};
}
