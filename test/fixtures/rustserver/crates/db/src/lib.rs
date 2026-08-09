//! A sibling crate, `pub` from end to end.
//!
//! Every name here is public because that is the only way the server crate can see it.
//! None of it is an API anybody outside this workspace imports, and none of it is a
//! door — which is the whole of #140.

pub struct Account {
    pub id: i32,
}

pub fn find_account(id: i32) -> Account {
    Account { id }
}

pub fn insert_account(account: Account) -> i32 {
    account.id
}

pub fn delete_account(id: i32) -> bool {
    id > 0
}
