# The application's entire URL surface, in a file App Atlas does not open. discourse's
# copy of this file is 1,993 lines long and no number in the output was ever drawn from it.
Rails.application.routes.draw do
  resources :topics
  resources :posts
  namespace :admin do
    resources :users
  end
  get '/session' => 'sessions#show'
end
