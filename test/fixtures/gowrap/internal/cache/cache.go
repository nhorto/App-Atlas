// Package cache keeps answers the site has already worked out.
package cache

// Store holds a value per key until somebody asks for it.
type Store struct {
	values map[string]any
}

// New builds an empty store.
func New() *Store {
	return &Store{values: map[string]any{}}
}

// Get returns what was filed under key, or nil.
func (s *Store) Get(key string) any {
	return s.values[key]
}
