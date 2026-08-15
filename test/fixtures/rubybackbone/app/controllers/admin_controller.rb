class AdminController < ApplicationController
  before_action :ensure_staff

  def index
    render json: {}
  end
end
