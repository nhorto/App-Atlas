//! The estimating engine: the in-process rewrite of the Python data-gen.

pub mod modules;

pub use modules::estimating::EstimateRow;

/// How many rows one batch may hold.
pub const BATCH_SIZE: u32 = 500;
