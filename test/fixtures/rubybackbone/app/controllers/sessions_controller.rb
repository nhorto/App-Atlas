class SessionsController < ApplicationController
  skip_before_action :ensure_logged_in

  def show
    render json: { user: current_user }
  end
end
