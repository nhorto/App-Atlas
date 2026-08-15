class ApplicationController < ActionController::Base
  before_action :ensure_logged_in

  def ensure_logged_in
    render status: 403 unless current_user
  end
end
