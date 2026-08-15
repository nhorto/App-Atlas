class TopicsController < ApplicationController
  def index
    render json: Topic.all
  end
end
